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
    /** P78-s2.F1: an account makes at most 10 orgs a day. */
    limit: "You made as many orgs as you can today. Try again tomorrow.",
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
  errors: { empty: NEW_ORG.errors.empty, taken: NEW_ORG.errors.taken },
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
    /**
     * P78-s2.F1: membership ends in the invites' Revoke pattern (a quiet button at the row's end, no confirm, a
     * toast): an owner removes a member; a member leaves, from its own row, and lands on its next org's home.
     */
    /** The controls column's head, for a screen reader only. */
    actions: "Actions",
    /**
     * An owner makes a member an owner in the same pattern (no confirm; the row reads Owner and the toast says so),
     * so an owner can hand the org over and then leave it from its own row.
     */
    makeOwner: "Make owner",
    makeOwnerLabel: (email: string) => `Make ${email} an owner`,
    madeOwner: (email: string) => `${email} is an owner now.`,
    makeOwnerFailed: (email: string) => `Could not make ${email} an owner. Try again.`,
    remove: "Remove",
    removeLabel: (email: string) => `Remove ${email} from the org`,
    removed: (email: string) => `${email} removed.`,
    removeFailed: (email: string) => `Could not remove ${email}. Try again.`,
    /** The API's 409 `last_org`: every account keeps at least one org. */
    removeLastOrg: (email: string, org: string) => `${email} can't be removed: ${org} is their only org.`,
    leave: "Leave",
    leaveLabel: (org: string) => `Leave ${org}`,
    leaveFailed: (org: string) => `Could not leave ${org}. Try again.`,
    leaveLastOrg: (org: string) => `You can't leave ${org}: it's your only org.`,
    /** The API's 409 `last_owner`: an org keeps at least one owner. */
    leaveLastOwner: (org: string) => `You can't leave ${org}: make another member an owner first.`,
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
      /** P78-s2.F1: an account sends at most 10 invites an hour and 30 a day; an address gets at most 3 a day. */
      limit: "You sent as many invites as you can for now. Try again later.",
      recipient: (email: string) => `${email} got as many invites as it can today. Try again tomorrow.`,
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
      /** `org` is empty for a code the API does not know, or none (P78, OQ3): the same words, no name. */
      text: (org: string) =>
        `It expired, was revoked or was used already. Ask an owner of ${org || "the org"} for a new one.`,
    },
  },
} as const;
