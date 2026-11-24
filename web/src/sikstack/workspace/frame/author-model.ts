/**
 * Who wrote or opened something on the agenda (P61-e9), as the engine stores it: `person:<handle>` or
 * `agent:<name>`. A person is their handle (the part of the account's email before `@`; the email never shows); an
 * agent is its name, which `Author` marks `Agent`, so the two are told apart by a word, never by colour alone.
 */
export interface AuthorName {
  name: string;
  agent: boolean;
}

/** `person:mina` → mina; `agent:fold` → fold, an agent; anything else as written, a person. */
export function authorOf(stored: string | null | undefined): AuthorName | null {
  if (!stored) return null;
  const at = stored.indexOf(":");
  const kind = at > 0 ? stored.slice(0, at) : "";
  const name = at > 0 ? stored.slice(at + 1) : stored;
  if (!name) return null;
  return { name, agent: kind === "agent" };
}
