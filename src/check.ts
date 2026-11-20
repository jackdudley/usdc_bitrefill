/** Self-check for the money path. Costs nothing: hits the real (free) 402 challenge,
 *  signs with a throwaway key, and intercepts the paid retry before it leaves.
 *  usage: npx tsx src/check.ts */
import assert from "node:assert";
import { createWalletClient, http, publicActions, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";
import { PaymentRequirementsSchema } from "x402/types";
import { v2Shim } from "./x402v2.js";
import { nextStep, priceUsd } from "./bitrefill.js";

const URL_ = "https://api.bitrefill.com/x402/gift-cards/search?q=starbucks&country=US";
const burner = privateKeyToAccount(generatePrivateKey()); // never funded, never used again
const wallet = createWalletClient({ account: burner, chain: base, transport: http() }).extend(publicActions);

const main = async () => {
  // 1. the live v2 challenge is unparseable by the v1 library -- the reason this shim exists
  const raw = await (await fetch(URL_)).json();
  assert.equal(raw.x402Version, 2, "Bitrefill no longer serves x402 v2 -- re-check the shim");
  assert.equal(PaymentRequirementsSchema.safeParse(raw.accepts[0]).success, false);
  console.log("1. live 402 is x402 v2 and rejected by x402-fetch's v1 schema  ✓");

  // 2. shimmed, every Base option parses
  const shimmed = await (await v2Shim(fetch)(URL_)).json();
  assert.equal(shimmed.x402Version, 1);
  for (const a of shimmed.accepts) assert.ok(PaymentRequirementsSchema.safeParse(a).success);
  assert.equal(shimmed.accepts[0].maxAmountRequired, "2000"); // $0.002 micro-fee
  assert.equal(shimmed.accepts[0].extra.name, "USD Coin");    // EIP-712 domain survived
  console.log(`2. shim -> v1, ${shimmed.accepts.length} Base option(s) parse, domain intact  ✓`);

  // 3. full sign, with the paid retry intercepted instead of sent
  let sent: any = null;
  const spy: typeof fetch = async (i: any, init: any = {}) => {
    const h = new Headers(init.headers ?? {});
    if (h.get("X-PAYMENT")) {
      sent = JSON.parse(Buffer.from(h.get("X-PAYMENT")!, "base64").toString());
      return new Response("{}", { status: 200 });
    }
    return fetch(i, init);
  };
  await wrapFetchWithPayment(v2Shim(spy), wallet as any, parseUnits("0.05", 6))(URL_);
  assert.ok(sent, "no X-PAYMENT header was produced");
  assert.equal(sent.x402Version, 2, "header must go back out as v2");
  assert.equal(sent.network, "eip155:8453");
  assert.match(sent.payload.signature, /^0x[0-9a-f]{130}$/i);
  assert.equal(sent.payload.authorization.from, burner.address);
  assert.equal(sent.payload.authorization.value, "2000");
  assert.equal(sent.payload.authorization.to, "0x480CD46E6faDe651a0437DeaddA53D5c8e7D846A");
  console.log("3. signed EIP-712 authorization, re-tagged v2, correct payee/amount  ✓");

  // 4. the cap is what actually stops an overpayment
  await assert.rejects(
    () => wrapFetchWithPayment(v2Shim(spy), wallet as any, parseUnits("0.000001", 6))(URL_),
    /exceeds maximum/,
    "cap did not reject a 402 above it",
  );
  console.log("4. a 402 above the cap throws before signing  ✓");

  // 5. next_step routing: follow its url, keep our method, our params beat its templates
  const searchJson = { next_step: { url: "/x402/products/detail", body: { slug: "<product slug from results>" } } };
  assert.deepEqual(nextStep(searchJson, { url: "/ignored", body: { slug: "starbucks-us" } }), {
    url: "/x402/products/detail?slug=starbucks-us", body: undefined,
  });
  const createJson = { next_step: { url: "/x402/invoice/pay", body: { invoice_id: "abc" } } };
  assert.deepEqual(nextStep(createJson, { url: "/ignored", method: "POST", body: { invoice_id: "abc" }, capUsdc: 5 }), {
    url: "/x402/invoice/pay", method: "POST", body: { invoice_id: "abc" }, capUsdc: 5,
  });
  assert.deepEqual(nextStep({}, { url: "/fallback" }), { url: "/fallback" }); // no next_step -> documented path
  console.log("5. next_step followed for url, our params beat its templates  \u2713");

  // 6. price_usdc is atomic, not dollars -- mixing these up is a 1e6 error on a money path
  assert.equal(priceUsd({ price_usdc: "25000000", price_usd: 25 }), 25);
  assert.equal(priceUsd({ price_usdc: "5000000" }), 5);
  console.log("6. atomic price_usdc reads back as dollars  \u2713");

  console.log("\nall checks passed -- no funds moved");
};
main().catch(e => { console.error("CHECK FAILED:", e.message); process.exit(1); });
