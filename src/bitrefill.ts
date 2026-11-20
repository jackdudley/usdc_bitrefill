/**
 * Bitrefill x402 client. Every Bitrefill request goes through `call()`.
 *
 * How paying works: gated routes answer HTTP 402. @x402/fetch signs a USDC transfer
 * (EIP-3009) on Base and retries. Fees: search/create $0.002, detail/status $0.001;
 * /invoice/pay costs the invoice price. The key lives server-side, so we pay per call
 * instead of using Bitrefill's SIWX->JWT login, which only saves a wallet prompt we never show.
 *
 * Safety:
 * - every payment is capped before signing: MICRO_FEE_CAP_USDC by default, the exact
 *   invoice price for /pay, and never above HARD_CAP_USDC
 * - only api.bitrefill.com is called (next_step URLs are untrusted)
 * - every request/response goes to logs/<run>.jsonl with redemption codes redacted
 */
import "dotenv/config";
import { appendFileSync, mkdirSync } from "node:fs";
import { createWalletClient, http, publicActions, formatUnits, erc20Abi } from "viem";
import { privateKeyToAccount, type LocalAccount } from "viem/accounts";
import { base } from "viem/chains";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";

const API = "https://api.bitrefill.com";
const USDC_ON_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** No single payment above this, whatever the API or the agent asks for. */
export const HARD_CAP_USDC = 10;
/** Default cap: covers the gated-route fees with headroom, nothing more. */
const MICRO_FEE_CAP_USDC = 0.05;

/**
 * fetch that pays 402s in Base USDC and refuses, before signing, any 402 above `capUsdc`.
 * `inner` lets check.ts intercept the paid retry.
 */
export const payingFetch = (account: LocalAccount, capUsdc: number, inner: typeof fetch = fetch) => {
  if (capUsdc > HARD_CAP_USDC) throw new Error(`cap ${capUsdc} exceeds hard cap ${HARD_CAP_USDC} USDC`);
  const client = new x402Client()
    .register("eip155:8453", new ExactEvmScheme(toClientEvmSigner(account)))
    .setSpendControls({ maxAmountPerPayment: `$${capUsdc}` });
  return wrapFetchWithPayment(inner, client);
};

// Wallet is built on first use, so check.ts runs without a .env.
const makeWallet = () => {
  const pk = process.env.AGENT_PRIVATE_KEY;
  if (!pk || !/^0x[0-9a-f]{64}$/i.test(pk)) throw new Error("AGENT_PRIVATE_KEY missing or malformed (see .env.example)");
  return createWalletClient({
    account: privateKeyToAccount(pk as `0x${string}`),
    chain: base,
    transport: http(process.env.BASE_RPC_URL || undefined),
  }).extend(publicActions);
};
let _wallet: ReturnType<typeof makeWallet> | undefined;
const wallet = () => (_wallet ??= makeWallet());

export const address = () => wallet().account.address;

/** Wallet's USDC balance on Base, in dollars. */
export const usdcBalance = async () => {
  const raw = await wallet().readContract({
    address: USDC_ON_BASE, abi: erc20Abi, functionName: "balanceOf", args: [address()],
  });
  return Number(formatUnits(raw, 6));
};

mkdirSync("logs", { recursive: true });
const LOG = `logs/${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;

/** Redemption codes are bearer money: keep them out of the log file (stdout still shows them). */
const redact = (v: unknown): unknown =>
  JSON.parse(
    JSON.stringify(v, (k, val) =>
      /code|pin|redemption_info|invoice_access_token|payment_link|secret|token/i.test(k) ? "[REDACTED]" : val,
    ),
  );

const log = (event: string, data: unknown) => {
  const line = { t: new Date().toISOString(), event, data: redact(data) };
  appendFileSync(LOG, JSON.stringify(line) + "\n");
  console.log(`  · ${event}`, JSON.stringify(line.data).slice(0, 220));
};

export type Call = { url: string; method?: "GET" | "POST"; body?: unknown; capUsdc?: number };
export type Result<T = any> = { json: T; txHash?: string };

/**
 * One Bitrefill request, paying its 402 if needed. `capUsdc` (default MICRO_FEE_CAP_USDC)
 * is the most it may pay. Throws on non-2xx. `txHash` is set when a payment settled.
 */
export async function call<T = any>({ url, method = "GET", body, capUsdc = MICRO_FEE_CAP_USDC }: Call): Promise<Result<T>> {
  const full = url.startsWith("http") ? url : API + url;
  if (new URL(full).hostname !== "api.bitrefill.com") throw new Error(`refusing off-host call: ${full}`);

  log("request", { url: full, method, body, capUsdc });
  const res = await payingFetch(wallet().account, capUsdc)(full, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    log("error", { status: res.status, json });
    throw new Error(`${res.status} on ${full}: ${text.slice(0, 300)}`);
  }

  const header = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
  const txHash = header ? decodePaymentResponseHeader(header).transaction : undefined;
  log("response", { status: res.status, txHash, json });
  if (txHash) console.log(`  $ paid (cap ${capUsdc} USDC) -> https://basescan.org/tx/${txHash}`);
  return { json, txHash };
}

/**
 * Next request after `json`: take the URL from Bitrefill's next_step, but keep our own
 * method and params (its body is a template like "<product slug from results>").
 * GET params go in the query string. No next_step -> `fallback` unchanged.
 */
export const nextStep = (json: any, fallback: Call): Call => {
  const ns = json?.next_step;
  if (!ns?.url) return fallback;
  const method = fallback.method ?? "GET";
  const params = fallback.body ?? ns.body;
  if (method === "GET" && params && typeof params === "object") {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    return { ...fallback, url: `${ns.url}?${qs}`, body: undefined };
  }
  return { ...fallback, url: ns.url, method, body: params };
};

/** Invoice price in dollars. price_usdc is atomic (6dp): "25000000" = $25. */
export const priceUsd = (inv: any): number =>
  typeof inv?.price_usd === "number" ? inv.price_usd : Number(inv?.price_usdc) / 1e6;
