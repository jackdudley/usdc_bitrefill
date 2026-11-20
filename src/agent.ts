/**
 * Gift-card agent: Claude + four tools over the Bitrefill x402 client.
 *
 *   search_products -> get_quote -> (user says "yes") -> purchase -> check_order
 *
 * Safety is enforced here in code, not by the prompt:
 * - purchase only pays an invoice the *user* confirmed: get_quote marks it pending, and
 *   only if the very next user message is a plain "yes" does it become confirmed.
 *   Anything else clears it. One yes pays once.
 * - every payment must fit the session's remaining budget and HARD_CAP_USDC.
 * - every payment is logged (product, amount, tx hash, Basescan link) to the session and logs/.
 */
import Anthropic from "@anthropic-ai/sdk";
import { call, nextStep, priceUsd, log, HARD_CAP_USDC } from "./bitrefill.js";

const MODEL = "claude-opus-5-5";

/** Plain affirmative only: "Yes.", "yeah", "go ahead please". "yes but make it $10" is not a yes. */
const YES = /^\s*(yes|yeah|yep|yup|sure|confirm(ed)?|do it|go ahead|ok(ay)?)( please)?[\s.!,]*$/i;

export type Quote = {
  invoiceId: string;
  product: string;
  value: string;
  currency: string;
  priceUsd: number;
  expiresAt: number;
  created: any; // create-invoice response; its next_step says where to pay
};
export type Payment = {
  at: string;
  product: string;
  amountUsd: number;
  invoiceId: string;
  txHash: string;
  basescan: string;
};

export class Session {
  spentUsd = 0;
  quotes = new Map<string, Quote>();
  /** Invoice awaiting the user's yes (set by get_quote). */
  pending?: string;
  /** Invoice the user said yes to; consumed by purchase. */
  confirmed?: string;
  payments: Payment[] = [];
  messages: Anthropic.Beta.BetaMessageParam[] = [];
  lastSearch?: any;

  constructor(public budgetUsd = Number(process.env.SESSION_BUDGET_USD) || 15) {}

  get remainingUsd() {
    return this.budgetUsd - this.spentUsd;
  }

  /** Called with every user message before the model sees it. */
  userSaid(text: string) {
    this.confirmed = this.pending && YES.test(text) ? this.pending : undefined;
    this.pending = undefined;
  }
}

/** Order status; includes redemption details once delivered. */
const orderStatus = async (invoiceId: string) => {
  const { json } = await call({ url: `/x402/invoice/status?invoice_id=${encodeURIComponent(invoiceId)}` });
  const delivered = json.delivery_status === "all_delivered";
  return {
    invoice_id: invoiceId,
    status: json.status,
    delivery_status: json.delivery_status,
    redemption: delivered ? (json.redemption_info?.orders ?? []).map((o: any) => o.redemption_info ?? o) : undefined,
  };
};

type Handler = (s: Session, input: any) => Promise<unknown>;

export const handlers: Record<string, Handler> = {
  async search_products(s, { query, country }) {
    const { json } = await call({
      url: `/x402/gift-cards/search?q=${encodeURIComponent(query)}&country=${encodeURIComponent(country || "US")}`,
    });
    s.lastSearch = json;
    return (json.products ?? []).slice(0, 8).map((p: any) => ({ name: p.name, slug: p.slug, in_stock: p.in_stock }));
  },

  async get_quote(s, { slug, value }) {
    const detail = await call(nextStep(s.lastSearch, { url: "/x402/products/detail", body: { slug } }));
    const d = detail.json;
    const pkg = (d.packages ?? []).find((p: any) => p.package_value === String(value));
    if (!pkg) return { refused: `no ${value} package`, available: (d.packages ?? []).map((p: any) => p.package_value) };
    // ponytail: package_value approximates price (5 -> $5.04); the exact check is after create
    if (Number(pkg.package_value) > Math.min(s.remainingUsd, HARD_CAP_USDC))
      return { refused: `over budget: $${s.remainingUsd.toFixed(2)} left, hard cap $${HARD_CAP_USDC}` };

    const created = await call(
      nextStep(d, {
        url: "/x402/invoice/create",
        method: "POST",
        body: { items: [{ product_id: d.id, package_value: pkg.package_value }] },
      }),
    );
    const inv = created.json;
    const price = priceUsd(inv);
    if (!inv.invoice_id || !Number.isFinite(price)) throw new Error("bad invoice from Bitrefill");
    if (price > Math.min(s.remainingUsd, HARD_CAP_USDC))
      return { refused: `price $${price} over budget: $${s.remainingUsd.toFixed(2)} left, hard cap $${HARD_CAP_USDC}` };

    s.quotes.set(inv.invoice_id, {
      invoiceId: inv.invoice_id,
      product: d.name,
      value: pkg.package_value,
      currency: pkg.package_currency,
      priceUsd: price,
      expiresAt: Date.now() + (inv.expires_in_minutes ?? 30) * 60_000,
      created: inv,
    });
    s.pending = inv.invoice_id;
    return {
      invoice_id: inv.invoice_id,
      product: d.name,
      value: `${pkg.package_value} ${pkg.package_currency}`,
      total_usdc: price,
      next: "Tell the user the product and total price, then wait. Only their next message being a plain yes allows purchase.",
    };
  },

  async purchase(s, { invoice_id }) {
    const q = s.quotes.get(invoice_id);
    if (!q) return { refused: "unknown invoice; get a quote first" };
    if (s.confirmed !== invoice_id) return { refused: "user has not confirmed this quote; state product and price and ask" };
    if (Date.now() > q.expiresAt) return { refused: "quote expired; get a new one" };
    if (q.priceUsd > Math.min(s.remainingUsd, HARD_CAP_USDC))
      return { refused: `over budget: $${s.remainingUsd.toFixed(2)} left` };

    // Consume the yes and reserve the budget before paying: one yes pays at most once,
    // and a payment that errors after settling still counts against the budget.
    // ponytail: a pre-signing failure also burns the reservation; refund on known-unsigned errors if it bites
    s.confirmed = undefined;
    s.spentUsd += q.priceUsd;

    let txHash: string | undefined;
    try {
      ({ txHash } = await call(
        nextStep(q.created, { url: "/x402/invoice/pay", method: "POST", body: { invoice_id }, capUsdc: q.priceUsd }),
      ));
    } catch (e: any) {
      return { error: `payment failed or state unknown: ${e.message}. Use check_order before retrying.` };
    }
    const payment: Payment = {
      at: new Date().toISOString(),
      product: `${q.product} ${q.value} ${q.currency}`,
      amountUsd: q.priceUsd,
      invoiceId: invoice_id,
      txHash: txHash ?? "unknown",
      basescan: `https://basescan.org/tx/${txHash}`,
    };
    s.payments.push(payment);
    log("payment", payment);

    // delivery usually takes ~5s; poll briefly ($0.001/poll), check_order covers the rest
    let st = await orderStatus(invoice_id);
    for (let i = 0; i < 6 && st.delivery_status !== "all_delivered"; i++) {
      await new Promise(r => setTimeout(r, 5000));
      st = await orderStatus(invoice_id);
    }
    return { paid: payment, ...st };
  },

  async check_order(_s, { invoice_id }) {
    return orderStatus(invoice_id);
  },
};

const strictObject = (properties: Record<string, unknown>) => ({
  type: "object" as const,
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "search_products",
    description: "Search Bitrefill gift cards by brand or keyword. Returns name, slug, in_stock.",
    input_schema: strictObject({
      query: { type: "string" },
      country: { type: "string", description: "ISO country code, e.g. US" },
    }),
    strict: true,
  },
  {
    name: "get_quote",
    description:
      "Create an invoice for one gift card. value must be an exact package value (e.g. \"5\"); if it doesn't exist, the result lists available values. Returns the total USDC price. Does not pay.",
    input_schema: strictObject({ slug: { type: "string" }, value: { type: "string" } }),
    strict: true,
  },
  {
    name: "purchase",
    description:
      "Pay a quoted invoice in USDC. Only works if the user's latest message was a plain yes to that quote. Returns the payment and, once delivered, the redemption code/link.",
    input_schema: strictObject({ invoice_id: { type: "string" } }),
    strict: true,
  },
  {
    name: "check_order",
    description: "Delivery status of a paid invoice, with the redemption code/link once delivered.",
    input_schema: strictObject({ invoice_id: { type: "string" } }),
    strict: true,
  },
];

const system = (s: Session) =>
  `You are a voice assistant that buys gift cards with USDC. Replies are spoken aloud: short, plain sentences, no markdown, no long IDs or URLs unless asked.
Flow: search_products, then get_quote. After a quote, say the product and total price and ask "Should I buy it?". Then stop and wait.
Only call purchase after the user says yes to that quote. The tool enforces this; never claim a purchase happened unless purchase returned "paid".
If a request is over budget or a value doesn't exist, say so and offer the closest option.
After delivery, read back the redemption code or say the link is ready.
Session budget: $${s.budgetUsd}; per-purchase hard cap: $${HARD_CAP_USDC}.`;

let _client: Anthropic | undefined;
const client = () => (_client ??= new Anthropic());

/** One user turn: runs the tool loop until Claude replies with text. */
export async function send(s: Session, text: string): Promise<string> {
  s.userSaid(text);
  s.messages.push({ role: "user", content: text });

  for (let i = 0; i < 12; i++) {
    const res = await client().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: system(s),
      tools: TOOLS,
      messages: s.messages,
      output_config: { effort: "low" }, // chatty voice turns; raise if tool choices get sloppy
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    s.messages.push({ role: "assistant", content: res.content });

    if (res.stop_reason === "refusal") return "Sorry, I can't help with that.";
    if (res.stop_reason !== "tool_use") {
      return res.content.flatMap(b => (b.type === "text" ? [b.text] : [])).join(" ").trim();
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const b of res.content) {
      if (b.type !== "tool_use") continue;
      const handler = handlers[b.name];
      let out: unknown;
      try {
        out = handler ? await handler(s, b.input) : { error: `unknown tool ${b.name}` };
      } catch (e: any) {
        out = { error: e.message };
      }
      results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out) });
    }
    s.messages.push({ role: "user", content: results });
  }
  return "Sorry, that took too many steps. Try again?";
}
