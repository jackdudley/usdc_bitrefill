/**
 * x402 v2 <-> v1 shim.
 *
 * Bitrefill serves x402Version 2: CAIP-2 networks ("eip155:8453"), `amount`, and a
 * top-level `resource` object. x402-fetch@1.2.0 (latest) is v1-shaped: a network enum
 * ("base"), `maxAmountRequired`, and flat resource/description/mimeType. Its
 * PaymentRequirementsSchema.parse() rejects the v2 challenge before any selector runs,
 * so a paymentRequirementsSelector cannot fix this from outside.
 *
 * So: translate the 402 down to v1 on the way in, and patch the signed X-PAYMENT header
 * back up to v2 on the way out. The EIP-712 signature covers only the USDC
 * transferWithAuthorization struct and domain -- never `network` or `x402Version` -- so
 * rewriting those two fields after signing leaves a valid signature. All crypto stays in
 * the official library.
 *
 * ponytail: drop this file the day x402-fetch ships v2 support; `fetch` goes back to bare.
 */
const BASE = "eip155:8453";

/** v2 accepts entry -> v1 PaymentRequirements. Base USDC only; we ignore Solana/Lightning. */
const toV1 = (a: any, resource: any) => ({
  scheme: a.scheme,
  network: "base",
  maxAmountRequired: String(a.amount),
  resource: resource?.url ?? "https://api.bitrefill.com/",
  description: resource?.description ?? "",
  mimeType: resource?.mimeType ?? "application/json",
  payTo: a.payTo,
  maxTimeoutSeconds: a.maxTimeoutSeconds ?? 300,
  asset: a.asset,
  extra: a.extra, // EIP-712 domain name/version -- must survive
});

/** Wraps a fetch so x402-fetch sees v1 and Bitrefill sees v2. */
export const v2Shim = (inner: typeof fetch): typeof fetch =>
  (async (input: any, init: any = {}) => {
    // Outbound: the library signed a v1 header; Bitrefill advertised v2.
    const hdrs = new Headers(init.headers ?? {});
    const payment = hdrs.get("X-PAYMENT");
    if (payment) {
      const p = JSON.parse(Buffer.from(payment, "base64").toString());
      p.x402Version = 2;
      p.network = BASE;
      hdrs.set("X-PAYMENT", Buffer.from(JSON.stringify(p)).toString("base64"));
      return inner(input, { ...init, headers: hdrs });
    }

    const res = await inner(input, init);
    if (res.status !== 402) return res;

    // Inbound: rewrite the v2 challenge into the v1 shape the library can parse.
    const body = await res.clone().json();
    const base = (body.accepts ?? []).filter((a: any) => a.network === BASE && a.scheme === "exact");
    if (!base.length) throw new Error("no Base USDC option in 402 challenge");
    const v1 = { x402Version: 1, accepts: base.map((a: any) => toV1(a, body.resource)), error: body.error };
    return new Response(JSON.stringify(v1), { status: 402, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
