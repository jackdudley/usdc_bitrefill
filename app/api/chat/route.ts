import { Session, send } from "../../../src/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ponytail: one in-memory session per server process (single-user demo). Reloading the page keeps
// the budget; restarting the server resets it. Per-visitor sessions need auth, which is out of scope.
const g = globalThis as unknown as { session?: Session; busy?: boolean };
const session = () => (g.session ??= new Session());

export async function GET() {
  return Response.json({ state: session().view() });
}

export async function POST(req: Request) {
  const { text } = await req.json().catch(() => ({}));
  if (typeof text !== "string" || !text.trim() || text.length > 2000)
    return Response.json({ error: "Say or type a request first." }, { status: 400 });
  // turns run one at a time, so two quick "yes" clicks can't race each other
  if (g.busy) return Response.json({ error: "Still working on the last request." }, { status: 409 });

  g.busy = true;
  try {
    const reply = await send(session(), text.trim());
    return Response.json({ reply, state: session().view() });
  } catch (e: any) {
    console.error("chat failed:", e);
    return Response.json({ error: `The agent hit an error: ${e.message}`, state: session().view() }, { status: 500 });
  } finally {
    g.busy = false;
  }
}
