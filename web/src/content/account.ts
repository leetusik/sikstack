// ── sikstack's account page (`/account`, P78, F10) ─────────────────────────────────────────────
// No design round (built on the settled look): the org home's panel pattern, the in-place form of its Org name
// panel. Reached from the account menu. English chrome in sentence case.

export const ACCOUNT = {
  title: "Account",
  /** The account menu's link to this page. */
  menuLink: "Account",
  email: {
    heading: "Email",
  },
  password: {
    heading: "Password",
    change: "Change",
    current: "Current password",
    next: "New password",
    hint: "Use at least 8 characters.",
    cancel: "Cancel",
    save: "Save",
    saving: "Saving…",
    errors: {
      /** Empty, or the API's `current` refusal. */
      current: "The current password is not right.",
      short: "Enter a password of at least 8 characters.",
    },
    limited: "Too many attempts. Wait a few minutes and try again.",
    failed: "Could not change the password. Try again.",
    /** The toast once it is changed. */
    changed: "Password changed. Other sessions are signed out.",
  },
} as const;
