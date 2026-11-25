// The org surfaces' rules as pure functions (P78-s2.S2's design): New org's form, Members' invite form, and the
// invite link's view. No React and no I/O, so they are tested on their own; `new-org.tsx`, `members.tsx` and
// `invite.tsx` render what these return.

// ── New org ───────────────────────────────────────────────────────────────────────────────────

export type NewOrgPhase = "ready" | "empty" | "taken" | "limit" | "creating" | "failed";

/** What the create action answers: the new org (its cookie is set; the page lands on its home), or why not. */
export type CreateOrgResult =
  | { ok: true; id: string; name: string }
  | { ok: false; reason: "empty" | "taken" | "limit" | "failed" };

/** A name of 1 to 100 characters once trimmed (the API's bound is the build slice's to confirm). */
export function checkOrgName(draft: string): boolean {
  const name = draft.trim();
  return name.length >= 1 && name.length <= 100;
}

/** The phase a create's answer leaves the form in; `null`: it landed (the page moves on). */
export function phaseAfterCreate(result: CreateOrgResult): NewOrgPhase | null {
  return result.ok ? null : result.reason;
}

// ── Members ───────────────────────────────────────────────────────────────────────────────────

export type OrgRole = "owner" | "member";

export interface MemberRow {
  id: string;
  email: string;
  role: OrgRole;
  /** ISO instant. */
  joinedAt: string;
}

export interface InviteRow {
  id: string;
  email: string;
  /** ISO instants. */
  invitedAt: string;
  expiresAt: string;
}

/**
 * Why an invite was not sent: not an address, a member already, invited already, the inviter's limit, the
 * address's limit, or no answer.
 */
export type InviteRefusal = "address" | "member" | "invited" | "limit" | "recipient" | "failed";

export type InvitePhase = "list" | "open" | "sending" | InviteRefusal;

export type InviteResult = { ok: true; invite: InviteRow } | { ok: false; reason: InviteRefusal };

/** One address: something, an @, a domain with a dot; no spaces. The API decides the rest. */
export function looksLikeEmail(draft: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.trim());
}

/** The form is open in every phase but `list`. */
export function inviteFormOpen(phase: InvitePhase): boolean {
  return phase !== "list";
}

/** A field error (under Email) for the refusals about the address; the failed send is a notice instead. */
export function inviteFieldError(phase: InvitePhase): Exclude<InviteRefusal, "failed"> | null {
  return phase === "address" ||
    phase === "member" ||
    phase === "invited" ||
    phase === "limit" ||
    phase === "recipient"
    ? phase
    : null;
}

/** Newest first: an invite just sent is the table's first row. */
export function invitesNewestFirst(rows: readonly InviteRow[]): InviteRow[] {
  return [...rows].sort((a, b) => Date.parse(b.invitedAt) - Date.parse(a.invitedAt));
}

/** The owner first, then members by the day they joined. */
export function membersInOrder(rows: readonly MemberRow[]): MemberRow[] {
  return [...rows].sort(
    (a, b) =>
      (a.role === "owner" ? 0 : 1) - (b.role === "owner" ? 0 : 1) ||
      Date.parse(a.joinedAt) - Date.parse(b.joinedAt),
  );
}

// ── The invite link ───────────────────────────────────────────────────────────────────────────

/**
 * What the link's page shows: signed out (`out`, the pair to sign in or create an account with the invited
 * address); signed in as that address (`ready`, Join; `joining`; `failed` keeps the screen with the notice); and
 * the outcomes: signed in as another account (`other`), a member already (`member`), and a link that no longer
 * works (`expired`: expired, revoked or used, one state, so the page tells a link holder nothing more).
 */
export type InvitePagePhase = "out" | "ready" | "joining" | "failed" | "other" | "member" | "expired";

export interface InviteView {
  code: string;
  phase: InvitePagePhase;
  org: { id: string; name: string };
  /** The address the invite is bound to. */
  email: string;
  invitedBy: string;
  /** The signed-in account's address, or `null` signed out. */
  account: string | null;
}

/** The page's phase from the API's answer for the code and the session. */
export function invitePhase(input: {
  usable: boolean;
  signedIn: string | null;
  invited: string;
  member: boolean;
}): InvitePagePhase {
  if (!input.usable) return "expired";
  if (input.signedIn === null) return "out";
  if (input.member) return "member";
  return input.signedIn.trim().toLowerCase() === input.invited.trim().toLowerCase() ? "ready" : "other";
}

/** The confirm (the title, the facts and the actions) is drawn in these phases; the rest are outcomes. */
export function isInviteConfirm(phase: InvitePagePhase): boolean {
  return phase === "out" || phase === "ready" || phase === "joining" || phase === "failed";
}

/** The invite's own address: `/invite?code=…`, the `next` the sign-in pair carries. */
export function invitePath(code: string): string {
  return `/invite?code=${encodeURIComponent(code)}`;
}

/** The code as the address carries it, trimmed; anything that is not one string is no code. */
export function inviteCode(raw: string | string[] | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim();
  return code.length > 0 && code.length <= 200 ? code : null;
}

/** The invite code a sign-in's `next` carries (`/invite?code=…`, the invite page's pair), or `null`. */
export function inviteCodeOf(next: string): string | null {
  const base = "https://next.invalid";
  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    return null;
  }
  if (url.origin !== base || url.pathname !== "/invite") return null;
  return inviteCode(url.searchParams.get("code"));
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The page's first view from the API's read of the code (`GET /app/invite/{code}`, `server/orgs_api.py`) and the
 * signed-in account's address (`null` signed out). `valid` is the one usable state; `expired`, `revoked` and `used`
 * are the one `expired` page. Signed in, the read says whether the account is a member (and then the org's id, which
 * Already a member's way on posts).
 */
export function inviteViewFromServer(body: unknown, code: string, account: string | null): InviteView {
  const raw = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const org = raw.org !== null && typeof raw.org === "object" ? (raw.org as Record<string, unknown>) : {};
  const email = text(raw.email);
  const id = text(org.id);
  return {
    code,
    org: { id, name: text(org.name) },
    email,
    invitedBy: text(raw.invited_by),
    account,
    phase: invitePhase({
      usable: raw.state === "valid" && email !== "",
      signedIn: account,
      invited: email,
      member: raw.member === true && id !== "",
    }),
  };
}
