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
import { call, nextStep, priceUsd, log, HARD_CAP_USDC } from "./bitrefill";
import { EMAIL, loadContacts } from "./contacts";

const MODEL = "claude-opus-5-5";

/** Only affirmative words: "Yes.", "Yes, please.", "yeah go ahead". "yes but make it $10" is not a yes. */
const YES = /^\s*((yes|yeah|yep|yup|sure|confirm(ed)?|do it|go ahead|buy it|ok(ay)?|please)[\s.!,]*)+$/i;

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
  /** Bitrefill delivery_status, updated by purchase/check_order. */
  status?: string;
  redemption?: unknown[];
  /** Email address the card was sent to, if gifted. */
  sentTo?: string;
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
  /** Plain-text conversation for the UI. */
  transcript: { role: "user" | "agent"; text: string }[] = [];
  lastSearch?: any;
  /** Claude API spend so far (estimated from token usage). */
  aiSpentUsd = 0;
  aiBudgetUsd = Number(process.env.AI_BUDGET_USD) || 1;

  constructor(public budgetUsd = Number(process.env.SESSION_BUDGET_USD) || 15) {}

  get remainingUsd() {
    return this.budgetUsd - this.spentUsd;
  }

  /** Called with every user message before the model sees it. */
  userSaid(text: string) {
    this.confirmed = this.pending && YES.test(text) ? this.pending : undefined;
    this.pending = undefined;
  }

  /** What the UI shows. The pending quote comes from code, not from the model's words. */
  view() {
    const q = this.pending ? this.quotes.get(this.pending) : undefined;
    return {
      budgetUsd: this.budgetUsd,
      spentUsd: this.spentUsd,
      remainingUsd: this.remainingUsd,
      hardCapUsd: HARD_CAP_USDC,
      dryRun: !!process.env.DRY_RUN,
      pending: q ? { product: q.product, value: q.value, currency: q.currency, priceUsd: q.priceUsd } : null,
      payments: this.payments,
      transcript: this.transcript,
    };
  }
}

export type SessionView = ReturnType<Session["view"]>;

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

    if (process.env.DRY_RUN) {
      // test mode: every gate above ran for real; the invoice is left unpaid and expires
      const payment: Payment = {
        at: new Date().toISOString(),
        product: `${q.product} ${q.value} ${q.currency}`,
        amountUsd: q.priceUsd,
        invoiceId: invoice_id,
        txHash: "DRY_RUN",
        basescan: "",
        status: "dry_run",
      };
      s.payments.push(payment);
      log("payment", { ...payment, dryRun: true });
      return {
        dry_run: true,
        paid: payment,
        note: "DRY RUN: nothing was paid. If the user asked to send it to someone, still call send_gift now (it sends a marked test email). Tell the user this was a test.",
      };
    }

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
    payment.status = st.delivery_status;
    payment.redemption = st.redemption;
    return { paid: payment, ...st };
  },

  async check_order(s, { invoice_id }) {
    const st = await orderStatus(invoice_id);
    const p = s.payments.find(p => p.invoiceId === invoice_id);
    if (p) Object.assign(p, { status: st.delivery_status, redemption: st.redemption });
    return st;
  },

  async send_gift(s, { invoice_id, recipient_email, message }) {
    const p = s.payments.find(p => p.invoiceId === invoice_id);
    if (!p) return { refused: "no purchase with that invoice; buy the card first" };
    const to = String(recipient_email).trim().toLowerCase();
    if (!EMAIL.test(to)) return { refused: "that isn't a valid email address" };
    // the code is bearer money: only send it to an address the user said or saved as a contact
    if (!allowedRecipient(s, to)) return { refused: "that address isn't in the user's messages or contacts; ask them for it" };

    const test = p.status === "dry_run";
    if (!test && !p.redemption?.length) {
      await handlers.check_order(s, { invoice_id });
      if (!p.redemption?.length) return { refused: "card not delivered yet; try again in a minute" };
    }
    const emailId = await sendEmail(to, p, String(message ?? "").slice(0, 500), test);
    p.sentTo = to;
    log("gift_sent", { invoice_id, to, test, emailId }); // emailId: look it up under Emails in the Resend dashboard
    return { sent: true, to, test, note: test ? "Test email: tell the user no real card was sent." : undefined };
  },
};

export const allowedRecipient = (s: Session, email: string) =>
  userGaveEmail(s, email) || loadContacts().some(c => c.email === email);

/** True if `email` is one of the words the user said or typed ("alex at gmail dot com" counts). */
export const userGaveEmail = (s: Session, email: string) =>
  s.transcript.some(
    m =>
      m.role === "user" &&
      m.text
        .toLowerCase()
        .replace(/\s+at\s+/g, "@")
        .replace(/\s+dot\s+/g, ".")
        .split(/\s+/)
        .some(w => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "") === email),
  );

const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Email the redemption link/code via Resend. Without a verified domain, Resend's test sender
 *  only delivers to the Resend account's own address. */
async function sendEmail(to: string, p: Payment, note: string, test: boolean): Promise<string> {
  const items = (p.redemption ?? []) as any[];
  const lines = test
    ? ["This is a test. No real gift card was bought."]
    : items.flatMap(r => [
        r.link && `Open your gift card: ${r.link}`,
        r.code && `Code: ${r.code}`,
        r.pin && `PIN: ${r.pin}`,
        r.instructions,
      ]).filter(Boolean);
  const text = [note && `"${note}"`, `You've got a ${p.product} gift card.`, ...lines].filter(Boolean).join("\n\n");
  const html = text
    .split("\n\n")
    .map(par => `<p>${esc(par).replace(/(https:\/\/\S+)/g, '<a href="$1">$1</a>')}</p>`)
    .join("");

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY ?? ""}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || "Gift agent <onboarding@resend.dev>",
      to: [to],
      subject: `${test ? "[TEST] " : ""}You've got a ${p.product} gift card`,
      text,
      html,
    }),
  });
  if (!r.ok) throw new Error(`email failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).id;
}

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
    name: "send_gift",
    description:
      "Email a purchased card's redemption link/code to someone, with the user's note. Only after purchase. recipient_email must be an address the user gave; message is their note (empty string if none).",
    input_schema: strictObject({
      invoice_id: { type: "string" },
      recipient_email: { type: "string" },
      message: { type: "string" },
    }),
    strict: true,
  },
  {
    name: "check_order",
    description: "Delivery status of a paid invoice, with the redemption code/link once delivered.",
    input_schema: strictObject({ invoice_id: { type: "string" } }),
    strict: true,
  },
];

// Token rails, enforced in code. The prompt keeps the agent on topic; these bound the cost
// when it isn't.
const MAX_INPUT_CHARS = 300; // spoken requests are short; longer is paste/abuse
const MAX_STEPS = 6; // model calls per user turn (search, quote, purchase, send_gift fit easily)
const MAX_REPLY_TOKENS = 2048; // thinking + a one-or-two sentence reply
// ponytail: Opus 5.5 list prices; fallback-model turns priced the same, close enough for a cap
const costUsd = (u: Anthropic.Beta.BetaUsage) =>
  ((u.input_tokens ?? 0) * 4 +
    (u.cache_creation_input_tokens ?? 0) * 5 +
    (u.cache_read_input_tokens ?? 0) * 0.2 +
    (u.output_tokens ?? 0) * 20) /
  1e6;

const system = (s: Session) =>
  `You are a voice assistant that buys gift cards with USDC. Replies are spoken aloud: one or two short, plain sentences, no markdown, no long IDs or URLs unless asked.
Scope: only finding, quoting, buying and checking gift cards. For anything else (general questions, chit-chat, writing, code, other tasks) say in one sentence that you only handle gift cards, and call no tools.
Flow: search_products, then get_quote. After a quote, say the product and total price and ask "Should I buy it?". Then stop and wait.
Only call purchase after the user says yes to that quote. The tool enforces this; never claim a purchase happened unless purchase returned "paid".
A quote can only be confirmed by the user's very next message. If they say anything else, it's dead: call get_quote again before asking for a yes.
If a request is over budget or a value doesn't exist, say so and offer the closest option.
After delivery, read back the redemption code or say the link is ready.
Gifts: if the user wants the card sent to someone, include the email address in the quote question ("Should I buy it and email it to alex@example.com?"). After purchase returns paid, call send_gift with that address and their note, then confirm it was sent. Spoken addresses like "alex at gmail dot com" mean alex@gmail.com.
Session budget: $${s.budgetUsd}; per-purchase hard cap: $${HARD_CAP_USDC}.
Contacts (name: email): ${loadContacts().map(c => `${c.name}: ${c.email}`).join("; ") || "none yet"}. When the user names a contact ("send Alex a card"), use that email; if the name isn't a contact, ask for the address or suggest adding them under Contacts.`;

let _client: Anthropic | undefined;
const client = () => (_client ??= new Anthropic());

/** One user turn: runs the tool loop until Claude replies with text. */
export async function send(s: Session, text: string): Promise<string> {
  text = text.trim();
  s.transcript.push({ role: "user", text });
  s.userSaid(text); // every message counts for the yes check, even ones refused below
  const reply =
    text.length > MAX_INPUT_CHARS
      ? "That's too long for me. Tell me in a sentence which gift card you want."
      : s.aiSpentUsd >= s.aiBudgetUsd
        ? "This session has used up its AI allowance. Restart the app to keep going."
        : await runTurn(s, text);
  s.transcript.push({ role: "agent", text: reply });
  return reply;
}

async function runTurn(s: Session, text: string): Promise<string> {
  s.messages.push({ role: "user", content: text });

  for (let i = 0; i < MAX_STEPS; i++) {
    const res = await client().beta.messages.create({
      model: MODEL,
      max_tokens: MAX_REPLY_TOKENS,
      system: system(s),
      tools: TOOLS,
      messages: s.messages,
      cache_control: { type: "ephemeral" }, // each turn resends the history; cached reads are ~10x cheaper
      output_config: { effort: "low" }, // chatty voice turns; raise if tool choices get sloppy
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    s.aiSpentUsd += costUsd(res.usage);

    if (res.stop_reason === "max_tokens") {
      // truncated reply may hold a half-written tool call; keep it out of history
      return "Sorry, I lost my train of thought. Could you say that again?";
    }
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
