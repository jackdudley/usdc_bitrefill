/**
 * Bitrefill x402 purchase flow. Phase 1 spike + the engine Phase 2's agent tools call.
 *
 * Path 2 (pay-per-call x402), not Path 1 (SIWX -> JWT): we hold the key server-side, so
 * there is no wallet approval prompt per micro-fee, which is the only reason the docs
 * steer agents to Path 1. Costs ~$0.005 in micro-fees per purchase and skips EIP-4361
 * message building, base64 SIWX headers, JWT refresh and the 5-minute nonce race.
 */
import "dotenv/config";
import { appendFileSync } from "node:fs";
import { createWalletClient, http, publicActions, parseUnits, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";
import { v2Shim } from "./x402v2.js";

const API = "https://api.bitrefill.com";
/** Refuse any single payment above this, whatever the API or the model asks for. */
export const HARD_CAP_USDC = 15;
/** Cap for the $0.001-$0.002 gated-route micro-fees. */
const MICRO_FEE_CAP_USDC = 0.05;

const usdc = (n: number) => parseUnits(n.toFixed(6), 6);

// Lazy: the pure helpers below stay importable (and testable) without a key in the env.
let _wallet: ReturnType<typeof createWalletClient> extends never ? never : any;
const signer = () => {
  if (_wallet) return _wallet;
  const pk = process.env.PRIVATE_KEY;
  if (!pk || !/^0x[0-9a-f]{64}$/i.test(pk)) throw new Error("PRIVATE_KEY missing or malformed (see .env.example)");
  _wallet = createWalletClient({
    account: privateKeyToAccount(pk as `0x${string}`),
    chain: base,
    transport: http(process.env.BASE_RPC_URL || undefined),
  }).extend(publicActions);
  return _wallet;
};
export const address = (): `0x${string}` => signer().account.address;

// ponytail: JSONL to a gitignored file. Good enough to debug a demo; no log lib.
const LOG = `logs/${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
/** Redemption codes are bearer money -> never hit the log file (they still print to stdout). */
const redact = (v: unknown): unknown =>
  JSON.parse(
    JSON.stringify(v, (k, val) =>
      /code|pin|redemption_info|invoice_access_token|payment_link|secret|token/i.test(k)
        ? "[REDACTED]"
        : val,
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
 * One gated call. x402-fetch does request -> 402 -> sign payment -> retry.
 * `capUsdc` is the real safety gate: a 402 demanding more than the cap throws before
 * anything is signed, which is also the "402 amount must equal the invoice price" check.
 */
export async function call<T = any>({ url, method = "GET", body, capUsdc }: Call): Promise<Result<T>> {
  const cap = capUsdc ?? MICRO_FEE_CAP_USDC;
  if (cap > HARD_CAP_USDC) throw new Error(`cap ${cap} exceeds hard cap ${HARD_CAP_USDC} USDC`);

  const full = url.startsWith("http") ? url : API + url;
  if (new URL(full).hostname !== "api.bitrefill.com")
    throw new Error(`refusing off-host call: ${full}`); // next_step is untrusted input

  log("request", { url: full, method, body, capUsdc: cap });
  const payFetch = wrapFetchWithPayment(v2Shim(fetch), signer(), usdc(cap));
  const res = await payFetch(full, {
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

  const header = res.headers.get("x-payment-response");
  const txHash = header ? decodeXPaymentResponse(header).transaction : undefined;
  log("response", { status: res.status, txHash, json });
  if (txHash) console.log(`  $ paid (cap ${cap} USDC) -> https://basescan.org/tx/${txHash}`);
  return { json, txHash };
}

/**
 * Follow the server's next_step for *where* to go; keep our own knowledge of the method.
 * next_step.body carries params even for GET routes (search -> detail), so a body does not
 * imply POST -- for GET they become query params.
 */
export const nextStep = (json: any, fallback: Call): Call => {
  const ns = json?.next_step;
  if (!ns?.url) return fallback;
  const method = fallback.method ?? "GET";
  // ns.body is a template ("<product slug from results>"), and we pick the product
  // and package anyway -- so follow its url, but our own params win.
  const params = fallback.body ?? ns.body;
  if (method === "GET" && params && typeof params === "object") {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    return { ...fallback, url: `${ns.url}?${qs}`, body: undefined };
  }
  return { ...fallback, url: ns.url, method, body: params };
};

/** price_usdc is atomic (6dp): "25000000" is $25. price_usd is the dollar number. */
export const priceUsd = (inv: any): number =>
  typeof inv?.price_usd === "number" ? inv.price_usd : Number(inv?.price_usdc) / 1e6;

export const usdcBalance = async () => {
  const w = signer();
  const bal = await w.readContract({
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "balanceOf",
    args: [w.account.address],
  });
  return Number(formatUnits(bal as bigint, 6));
};
