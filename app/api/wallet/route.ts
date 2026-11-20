/** Live on-chain USDC balance of the agent's wallet on Base. */
import { address, usdcBalance } from "../../../src/bitrefill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const addr = address();
    return Response.json({ address: addr, usdc: await usdcBalance(), basescan: `https://basescan.org/address/${addr}` });
  } catch (e: any) {
    console.error("wallet read failed:", e);
    return Response.json({ error: "Couldn't read the wallet balance." }, { status: 502 });
  }
}
