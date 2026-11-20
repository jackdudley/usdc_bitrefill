/**
 * Phase 1 spike: buy one gift card end to end.
 *   search -> detail -> create invoice -> pay via x402 -> poll -> print redemption
 *
 * usage: npm run spike -- <term> <value> <country> [--dry]
 *   npm run spike -- starbucks 5 US --dry   # stops before paying ($0.005 in fees)
 *
 * Picks the first in-stock hit and the package exactly matching <value>. Refuses if that
 * package doesn't exist, or the price is over HARD_CAP_USDC or the wallet balance.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { call, nextStep, priceUsd, usdcBalance, address, HARD_CAP_USDC } from "./bitrefill";

const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const [term = "starbucks", wantValue = "5", country = "US"] = args;
const DRY = process.argv.includes("--dry");

const main = async () => {
  console.log(`wallet ${address()}`);
  const bal = await usdcBalance();
  console.log(`USDC on Base: $${bal.toFixed(4)}\n`);

  console.log(`1. search "${term}" (${country})`);
  const search = await call({ url: `/x402/gift-cards/search?q=${encodeURIComponent(term)}&country=${country}` });
  const hits: any[] = search.json.products ?? [];
  const product = hits.find(p => p.in_stock) ?? hits[0];
  if (!product) throw new Error(`no products for "${term}"`);
  console.log(`   -> ${product.name} [${product.slug}] of ${hits.length} hits\n`);

  console.log(`2. detail ${product.slug}`);
  const detail = await call(nextStep(search.json, { url: "/x402/products/detail", body: { slug: product.slug } }));
  const d = detail.json;
  const packages: any[] = d.packages ?? [];
  console.log(`   packages: ${packages.map(p => p.package_value).join(", ")} ${packages[0]?.package_currency ?? ""}`);
  if (d.recipient_required) console.log(`   ! recipient_required (${d.recipient_type})`);

  // package_value must be the API's exact string; a mismatch is a 500 on create
  const chosen = packages.find(p => p.package_value === String(wantValue));
  if (!chosen) throw new Error(`REFUSED: no $${wantValue} package; available: ${packages.map(p => p.package_value).join(", ")}`);
  console.log(`   -> ${d.id} @ ${chosen.package_value}\n`);

  console.log(`3. create invoice`);
  const created = await call(
    nextStep(detail.json, {
      url: "/x402/invoice/create",
      method: "POST",
      body: { items: [{ product_id: d.id, package_value: chosen.package_value }] },
    }),
  );
  const inv = created.json;
  const price = priceUsd(inv);
  if (!inv.invoice_id || !Number.isFinite(price)) throw new Error(`bad invoice: ${JSON.stringify(inv)}`);
  console.log(`   -> ${inv.invoice_id}  $${price} USDC  expires ${inv.expires_in_minutes}min\n`);

  if (price > HARD_CAP_USDC) throw new Error(`REFUSED: $${price} over hard cap $${HARD_CAP_USDC}`);
  if (price > bal) throw new Error(`insufficient USDC: need $${price}, have $${bal.toFixed(4)}`);
  if (DRY) return console.log(`--dry: stopping before paying $${price}`);

  console.log(`4. pay $${price} USDC`);
  // cap = exact invoice price, so a 402 asking for any more throws before signing
  const paid = await call(
    nextStep(created.json, { url: "/x402/invoice/pay", method: "POST", body: { invoice_id: inv.invoice_id }, capUsdc: price }),
  );
  console.log(`   -> https://basescan.org/tx/${paid.txHash}\n`);

  // each status poll is a paid call ($0.001); 40 x 5s covers ~3 min
  console.log(`5. poll delivery`);
  for (let i = 0; i < 40; i++) {
    const { json: st } = await call({ url: `/x402/invoice/status?invoice_id=${inv.invoice_id}` });
    console.log(`   [${i}] ${st.status} / ${st.delivery_status}`);
    if (st.delivery_status === "all_delivered") {
      console.log(`\n=== REDEMPTION (not written to the log file) ===`);
      for (const o of st.redemption_info?.orders ?? []) console.log(JSON.stringify(o.redemption_info ?? o, null, 2));
      return;
    }
    await sleep(5000);
  }
  console.log(`\nundelivered after ~3min. invoice ${inv.invoice_id}: escalate to Bitrefill support after 3h.`);
};

main().catch(e => { console.error(`\nFAILED: ${e.message}`); process.exit(1); });
