// ── sikstack's org surfaces (P78-s2.S2's design) ─────────────────────────────────────────────
// The words of the org switcher's New org, New org (`/orgs/new`), Members (`/members`) and an invite's link
// (`/invite?code=…`). English chrome in sentence case; an org's name
// and an address are data, set at weight 500 where a sentence names them.

export const ORG_SHELL = {
  /** The org menu's foot: the way to New org. */
  newOrg: "New org",
  /** The org rail's section (after Feedback). */
  members: "Members",
} as const;

export const NEW_ORG = {
  title: "New org",
  nameLabel: "Name",
  cancel: "Cancel",
  create: "Create org",
  creating: "Creating…",
  errors: {
    empty: "Enter a name for the org.",
    taken: (name: string) => `You already have an org named ${name}.`,
  },
  failed: "Could not create the org. Try again.",
  /** The toast on the new org's home, where a create lands. */
  created: (name: string) => `Org ${name} created.`,
} as const;

/**
 * The org home's Org name panel (F15's rename, P78-s2.S4: no design round, built in the Public URL panel's
 * in-place pattern, its words taken from that panel and New org's; the operator meets it at the gate).
 */
export const ORG_NAME = {
  heading: "Org name",
  change: "Change",
  label: NEW_ORG.nameLabel,
  cancel: "Cancel",
  save: "Save",
  saving: "Saving…",
  errors: NEW_ORG.errors,
  saveFailed: "Could not save the org's name. Try again.",
} as const;

export const MEMBERS = {
  title: "Members",
  members: {
    heading: "Members",
    unit: "member",
    email: "Email",
    role: "Role",
    joined: "Joined",
    you: "You",
  },
  roles: { owner: "Owner", member: "Member" },
  invites: {
    heading: "Invites",
    unit: "invite",
    invite: "Invite",
    email: "Email",
    status: "Status",
    /** A pending invite's status: the day its link stops working. */
    expiresOn: (day: string) => `Expires ${day}`,
    empty: "No pending invites.",
    emailLabel: "Email",
    cancel: "Cancel",
    send: "Send invite",
    sending: "Sending…",
    revoke: "Revoke",
    revokeLabel: (email: string) => `Revoke the invite to ${email}`,
    sent: (email: string) => `Invite sent to ${email}.`,
    revoked: (email: string) => `Invite to ${email} revoked.`,
    errors: {
      address: "Enter an email address, like name@example.com.",
      member: (email: string, org: string) => `${email} is already a member of ${org}.`,
      invited: (email: string) => `${email} already has a pending invite.`,
    },
    failed: "Could not send the invite. Try again.",
  },
} as const;

/** The invite link's page (`/invite?code=…`), in the sign-in frame beside `/connect`. */
export const INVITE = {
  pageTitle: "Invite",
  title: (org: string) => `Join ${org}?`,
  /** Signed out: the address the invite is bound to, at weight 500. */
  signedOut: { before: "Sign in or create an account with ", after: " to join." },
  facts: { invitedBy: "Invited by", for: "Invite for", role: "Role" },
  createAccount: "Create account",
  signIn: "Sign in",
  join: (org: string) => `Join ${org}`,
  joining: "Joining…",
  failed: (org: string) => `Could not join ${org}. Try again.`,
  /** The toast on the org's home, where a join lands. */
  joined: (org: string) => `You joined ${org}.`,
  outcomes: {
    other: {
      title: "Signed in as another account",
      /** "This invite is for <address>. Sign in with that address to join." */
      before: "This invite is for ",
      after: ". Sign in with that address to join.",
      signOut: "Sign out",
    },
    member: {
      title: "Already a member",
      text: (org: string) => `You are already a member of ${org}.`,
      open: (org: string) => `Open ${org}`,
    },
    expired: {
      title: "This invite no longer works",
      text: (org: string) => `It expired, was revoked or was used already. Ask an owner of ${org} for a new one.`,
    },
  },
} as const;
