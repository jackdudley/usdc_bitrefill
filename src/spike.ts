/** Phase 1 spike: search -> detail -> invoice -> x402 pay -> poll -> print code.
 *  usage: npx tsx src/spike.ts "starbucks" 5 US [--dry] */
import { call, nextStep, priceUsd, usdcBalance, address, HARD_CAP_USDC } from "./bitrefill.js";

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

  // exact string from the API -- a wrong package_value is a 500 on create
  const chosen =
    packages.find(p => p.package_value === String(wantValue)) ??
    packages.filter(p => Number(p.package_value) <= HARD_CAP_USDC).sort((a, b) => +a.package_value - +b.package_value)[0];
  if (!chosen) throw new Error(`no package <= $${HARD_CAP_USDC}; saw ${packages.map(p => p.package_value).join(", ")}`);
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
  // cap == invoice price: a 402 asking for anything else throws before signing
  const paid = await call(
    nextStep(created.json, { url: "/x402/invoice/pay", method: "POST", body: { invoice_id: inv.invoice_id }, capUsdc: price }),
  );
  console.log(`   -> https://basescan.org/tx/${paid.txHash}\n`);

  console.log(`5. poll delivery`);
  for (let i = 0; i < 40; i++) {
    const { json: st } = await call({ url: `/x402/invoice/status?invoice_id=${inv.invoice_id}` });
    console.log(`   [${i}] ${st.status} / ${st.delivery_status}`);
    if (st.delivery_status === "all_delivered") {
      console.log(`\n=== REDEMPTION (not written to the log file) ===`);
      for (const o of st.redemption_info?.orders ?? []) console.log(JSON.stringify(o.redemption_info ?? o, null, 2));
      return;
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  console.log(`\nundelivered after ~3min. invoice ${inv.invoice_id} -- escalate after 3h.`);
};

main().catch(e => { console.error(`\nFAILED: ${e.message}`); process.exit(1); });
