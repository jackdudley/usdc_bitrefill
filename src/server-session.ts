/** The one in-memory session shared by the API routes (kept on globalThis so dev hot-reload keeps it). */
import { Session } from "./agent";

// ponytail: single-user demo. Reloading the page keeps the budget; restarting the server resets it.
// Per-visitor sessions need auth, which is out of scope.
const g = globalThis as unknown as { session?: Session };
export const session = () => (g.session ??= new Session());
