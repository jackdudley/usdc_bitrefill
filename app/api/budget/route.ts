/** Human-only control: set the session spend limit and per-card max. The agent has no tool for this. */
import { session } from "../../../src/server-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { budgetUsd, cardCapUsd } = await req.json().catch(() => ({}));
  try {
    const s = session();
    if (budgetUsd !== undefined) s.setBudget(Number(budgetUsd));
    if (cardCapUsd !== undefined) s.setCardCap(Number(cardCapUsd));
    return Response.json({ state: s.view() });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 400 });
  }
}
