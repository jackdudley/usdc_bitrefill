import { loadContacts, saveContact, removeContact } from "../../../src/contacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ contacts: loadContacts() });
}

export async function POST(req: Request) {
  const { name, email } = await req.json().catch(() => ({}));
  try {
    return Response.json({ contacts: saveContact(name, email) });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const { name } = await req.json().catch(() => ({}));
  return Response.json({ contacts: removeContact(name) });
}
