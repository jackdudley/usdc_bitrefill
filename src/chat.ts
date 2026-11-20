/**
 * Phase 2 terminal chat with the gift-card agent. Real money: purchases pay USDC on Base.
 * usage: npm run chat            (budget from SESSION_BUDGET_USD, default $15)
 *        DRY_RUN=1 npm run chat  (every check runs, stops before paying for the card)
 */
import readline from "node:readline/promises";
import { Session, send } from "./agent";

const s = new Session();
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
if (process.env.DRY_RUN) console.log("DRY RUN: purchases stop before paying (fees only)");
console.log(`budget $${s.budgetUsd}. Try: "buy me a $5 Starbucks card". Ctrl-C to quit.`);

let shown = 0;
for (;;) {
  const text = (await rl.question("\nyou> ")).trim();
  if (!text) continue;
  console.log(`\nagent> ${await send(s, text)}`);

  // printed by code, not the model, so the real numbers are always visible before a "yes"
  const q = s.pending ? s.quotes.get(s.pending) : undefined;
  if (q) console.log(`\n[awaiting yes: ${q.product} ${q.value} ${q.currency} for $${q.priceUsd} USDC]`);
  for (const p of s.payments.slice(shown)) console.log(`[paid: ${p.product} $${p.amountUsd} ${p.basescan}]`);
  shown = s.payments.length;
  console.log(`[budget: $${s.remainingUsd.toFixed(2)} of $${s.budgetUsd} left]`);
}
