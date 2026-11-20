/** Human-only control: set the session spend limit. The agent has no tool for this. */
import { session } from "../../../src/server-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { budgetUsd } = await req.json().catch(() => ({}));
  try {
    session().setBudget(Number(budgetUsd));
    return Response.json({ state: session().view() });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 400 });
  }
}
