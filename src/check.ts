/** Self-check for the money path. Costs nothing: hits the real (free) 402 challenge,
 *  signs with a throwaway key through the same payingFetch production uses, and
 *  intercepts the paid retry before it leaves.
 *  usage: npm run check */
import assert from "node:assert";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { payingFetch, nextStep, priceUsd, HARD_CAP_USDC } from "./bitrefill";
import { Session, handlers, send, userGaveEmail, type Quote } from "./agent";

const URL_ = "https://api.bitrefill.com/x402/gift-cards/search?q=starbucks&country=US";
const PAYEE = "0x480CD46E6faDe651a0437DeaddA53D5c8e7D846A";
const burner = privateKeyToAccount(generatePrivateKey()); // never funded, never used again

/** Real fetch for the 402; captures (and swallows) any request that carries a payment. */
const spy = () => {
  const seen: { header?: string } = {};
  const f: typeof fetch = async (i: any, init?: any) => {
    const req = new Request(i, init);
    const header = req.headers.get("PAYMENT-SIGNATURE") ?? req.headers.get("X-PAYMENT");
    if (header) {
      seen.header = header;
      return new Response("{}", { status: 200 });
    }
    return fetch(req);
  };
  return { f, seen };
};

const main = async () => {
  // 1. Bitrefill still speaks v2 -- the reason we use @x402/fetch, not x402-fetch@1
  const raw = await (await fetch(URL_)).json();
  assert.equal(raw.x402Version, 2);
  const baseOpt = raw.accepts.find((a: any) => a.network === "eip155:8453");
  assert.ok(baseOpt, "no Base option in live 402");
  console.log(`1. live 402 is x402 v2, Base USDC fee ${baseOpt.amount} atomic  ✓`);

  // 2. full sign via production's payingFetch, paid retry intercepted
  const s = spy();
  await payingFetch(burner, 0.05, s.f)(URL_);
  assert.ok(s.seen.header, "no payment header was produced");
  const sent = JSON.parse(Buffer.from(s.seen.header!, "base64").toString());
  assert.equal(sent.x402Version, 2);
  assert.equal(sent.accepted.network, "eip155:8453", "must pay on Base, not Arbitrum/Polygon");
  assert.match(sent.payload.signature, /^0x[0-9a-f]{130}$/i);
  const auth = sent.payload.authorization;
  assert.equal(auth.from, burner.address);
  assert.equal(auth.to, PAYEE);
  assert.equal(auth.value, baseOpt.amount);
  console.log("2. official v2 client signed EIP-3009 auth on Base, correct payee/amount  ✓");

  // 3. the cap is what stops an overpayment -- and nothing gets signed or sent
  const t = spy();
  await assert.rejects(() => payingFetch(burner, 0.000001, t.f)(URL_), /spendControls\.maxAmountPerPayment/);
  assert.equal(t.seen.header, undefined, "payment was sent despite exceeding the cap");
  console.log("3. a 402 above the cap throws, nothing signed or sent  ✓");

  // 4. no code path can raise the cap past the hard cap
  assert.throws(() => payingFetch(burner, HARD_CAP_USDC + 0.01), /hard cap/);
  console.log(`4. cap above $${HARD_CAP_USDC} hard cap refused  ✓`);

  // 5. next_step routing: follow its url, keep our method, our params beat its templates
  const searchJson = { next_step: { url: "/x402/products/detail", body: { slug: "<product slug from results>" } } };
  assert.deepEqual(nextStep(searchJson, { url: "/ignored", body: { slug: "starbucks-us" } }), {
    url: "/x402/products/detail?slug=starbucks-us", body: undefined,
  });
  const createJson = { next_step: { url: "/x402/invoice/pay", body: { invoice_id: "abc" } } };
  assert.deepEqual(nextStep(createJson, { url: "/ignored", method: "POST", body: { invoice_id: "abc" }, capUsdc: 5 }), {
    url: "/x402/invoice/pay", method: "POST", body: { invoice_id: "abc" }, capUsdc: 5,
  });
  assert.deepEqual(nextStep({}, { url: "/fallback" }), { url: "/fallback" });
  console.log("5. next_step followed for url, our params beat its templates  ✓");

  // 6. price_usdc is atomic, not dollars -- a 1e6 error on a money path
  assert.equal(priceUsd({ price_usdc: "25000000", price_usd: 25 }), 25);
  assert.equal(priceUsd({ price_usdc: "5000000" }), 5);
  console.log("6. atomic price_usdc reads back as dollars  ✓");

  // 7. confirmation gate: only a plain yes, immediately after the quote, confirms
  const quote = (s: Session, id: string, priceUsd: number, expiresAt = Date.now() + 60_000) => {
    s.quotes.set(id, { invoiceId: id, product: "X", value: "5", currency: "USD", priceUsd, expiresAt, created: {} } as Quote);
    s.pending = id;
  };
  const t7 = new Session(15);
  quote(t7, "inv1", 5.04);
  for (const said of ["Yes.", "Yes, please.", "yeah go ahead", "OK, buy it!"]) {
    quote(t7, "inv1", 5.04);
    t7.userSaid(said);
    assert.equal(t7.confirmed, "inv1", `"${said}" should confirm`);
  }
  for (const said of ["yes but make it $10", "no", "what about amazon?", "yes, send it to alex@x.com", "not yet"]) {
    quote(t7, "inv1", 5.04);
    t7.userSaid(said);
    assert.equal(t7.confirmed, undefined, `"${said}" must not confirm`);
  }
  quote(t7, "inv1", 5.04);
  t7.userSaid("hmm");
  t7.userSaid("yes"); // yes one message too late: quote no longer pending
  assert.equal(t7.confirmed, undefined);
  console.log("7. only an immediate plain yes confirms a quote  ✓");

  // 8. purchase refuses before any network call: unconfirmed, expired, over budget, unknown
  const pay = (s: Session, id: string) => handlers.purchase(s, { invoice_id: id }) as Promise<any>;
  const t8 = new Session(15);
  quote(t8, "a", 5.04);
  assert.match((await pay(t8, "a")).refused, /not confirmed/);
  quote(t8, "b", 5.04, Date.now() - 1);
  t8.userSaid("yes");
  assert.match((await pay(t8, "b")).refused, /expired/);
  const t8b = new Session(5);
  quote(t8b, "c", 5.04);
  t8b.userSaid("yes");
  assert.match((await pay(t8b, "c")).refused, /over budget/);
  assert.match((await pay(t8b, "zzz")).refused, /unknown invoice/);
  assert.equal(t8.spentUsd + t8b.spentUsd, 0, "refusals must not touch the budget");
  console.log("8. purchase refuses unconfirmed / expired / over-budget / unknown, budget untouched  ✓");

  // 9. token rails stop before any Claude call (no API key needed for these to pass)
  const t9 = new Session(15);
  quote(t9, "q", 5.04);
  assert.match(await send(t9, "x".repeat(301)), /too long/);
  assert.equal(t9.pending, undefined, "a refused message still kills the pending quote");
  t9.aiSpentUsd = t9.aiBudgetUsd;
  assert.match(await send(t9, "buy me a $5 starbucks card"), /AI allowance/);
  assert.equal(t9.messages.length, 0, "nothing was sent to Claude");
  console.log("9. long input and spent AI allowance refused before calling Claude  ✓");

  // 10. gift emails only go to an address the user said, for a card that was bought
  const t10 = new Session(15);
  t10.transcript.push({ role: "user", text: "buy a $5 starbucks card and send it to Alex at Gmail dot com, thanks" });
  t10.transcript.push({ role: "user", text: "also cc sam@example.org." });
  assert.ok(userGaveEmail(t10, "alex@gmail.com"), "spoken address counts");
  assert.ok(userGaveEmail(t10, "sam@example.org"), "typed address with trailing period counts");
  assert.ok(!userGaveEmail(t10, "attacker@evil.com"));
  assert.ok(!userGaveEmail(t10, "am@example.org"), "substring of a given address doesn't count");
  t10.payments.push({ at: "", product: "X", amountUsd: 5, invoiceId: "p1", txHash: "DRY_RUN", basescan: "", status: "dry_run" });
  const gift = (id: string, to: string) => handlers.send_gift(t10, { invoice_id: id, recipient_email: to, message: "" }) as Promise<any>;
  assert.match((await gift("nope", "alex@gmail.com")).refused, /buy the card first/);
  assert.match((await gift("p1", "not-an-email")).refused, /valid email/);
  assert.match((await gift("p1", "attacker@evil.com")).refused, /never gave/);
  console.log("10. gift email only to an address the user gave, only for a bought card  ✓");

  console.log("\nall checks passed -- no funds moved");
};
main().catch(e => { console.error("CHECK FAILED:", e.message); process.exit(1); });
