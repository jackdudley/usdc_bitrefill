/**
 * Contacts: name -> email, saved to contacts.json (gitignored: friends' emails stay off GitHub).
 * Added by the user in the UI; the agent may email gifts to these addresses.
 */
import { readFileSync, writeFileSync } from "node:fs";

export type Contact = { name: string; email: string };

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const file = () => process.env.CONTACTS_FILE || "contacts.json";

export const loadContacts = (): Contact[] => {
  try {
    return JSON.parse(readFileSync(file(), "utf8"));
  } catch {
    return [];
  }
};

/** Adds or replaces a contact by name (case-insensitive). Throws a user-facing message if invalid. */
export function saveContact(name: string, email: string): Contact[] {
  name = String(name ?? "").trim();
  email = String(email ?? "").trim().toLowerCase();
  if (!name || name.length > 40) throw new Error("Give the contact a name (up to 40 characters).");
  if (!EMAIL.test(email)) throw new Error("That email address doesn't look right.");
  const list = loadContacts().filter(c => c.name.toLowerCase() !== name.toLowerCase());
  list.push({ name, email });
  list.sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(file(), JSON.stringify(list, null, 2));
  return list;
}

export function removeContact(name: string): Contact[] {
  const list = loadContacts().filter(c => c.name.toLowerCase() !== String(name).toLowerCase());
  writeFileSync(file(), JSON.stringify(list, null, 2));
  return list;
}
