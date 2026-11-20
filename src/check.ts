/** Self-check for the money path. Costs nothing: hits the real (free) 402 challenge,
 *  signs with a throwaway key through the same payingFetch production uses, and
 *  intercepts the paid retry before it leaves.
 *  usage: npm run check */
import assert from "node:assert";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { payingFetch, nextStep, priceUsd, HARD_CAP_USDC } from "./bitrefill.js";

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

  console.log("\nall checks passed -- no funds moved");
};
main().catch(e => { console.error("CHECK FAILED:", e.message); process.exit(1); });
