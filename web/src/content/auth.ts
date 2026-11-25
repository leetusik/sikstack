// ── sikstack sign-in (job 01 *Sign in*, round 03-instrument; P58) ──────────────────
// The two screens' words, verbatim from the signed boards (`SignInForm.dc.html`,
// frame.md F4), read by `src/app/(auth)/` through this file's own path.

/** One screen's words: `sign-in` is `/login`, `sign-up` is `/signup`. */
export interface SignInScreenCopy {
  /** The `h1` and the document title. */
  title: string;
  submit: string;
  submitSending: string;
  /** The line under the panel: the question, then the link to the other screen. */
  altPrompt: string;
  altLink: string;
  altHref: string;
  /** Anything else, or no answer. */
  failed: string;
}

export const SIGN_IN_COPY = {
  wordmark: "sikstack",
  wordmarkLabel: "sikstack, home",
  email: "Email",
  password: "Password",
  passwordHint: "Use at least 8 characters.",
  errors: {
    /** 401, sign-in. */
    wrong: "Incorrect email or password.",
    /** 400 or 422. */
    invalid:
      "Enter a valid email address and a password of at least 8 characters.",
    /** 429. */
    limited: "Too many attempts. Wait a few minutes and try again.",
    /** 409, sign-up: the field error under Email ("Sign in" kept on one line). */
    taken: "An account with this email already exists. Sign in instead.",
  },
  screens: {
    "sign-in": {
      title: "Sign in",
      submit: "Sign in",
      submitSending: "Signing in…",
      altPrompt: "No account yet?",
      altLink: "Create account",
      altHref: "/signup",
      failed: "Could not sign in. Try again.",
    },
    "sign-up": {
      title: "Create account",
      submit: "Create account",
      submitSending: "Creating account…",
      altPrompt: "Already have an account?",
      altLink: "Sign in",
      altHref: "/login",
      failed: "Could not create your account. Try again.",
    },
  } satisfies Record<"sign-in" | "sign-up", SignInScreenCopy>,
} as const;

/**
 * The waitlist state (operator D2: no design round; signed components only). Shown in
 * place of the form after a waitlisted Create account or Sign in; the only new words on
 * these screens. `text` takes the email the person used.
 */
export const WAITLIST_COPY = {
  "sign-up": {
    title: "Account created",
    text: (email: string) =>
      `sikstack is still being built, so your account is on the waitlist. We will email ${email} when it opens.`,
  },
  "sign-in": {
    title: "Still on the waitlist",
    text: (email: string) =>
      `Your account is still on the waitlist. We will email ${email} when sikstack opens.`,
  },
  back: "Back to sign in",
} as const;

/**
 * Password reset (P78, F10: no design round; the sign-in frame's pieces and words). `/login` links to `/forgot`;
 * `/forgot` asks for the email and answers the same whatever the address; the mail's link opens `/reset?code=…`
 * (a new password, then sign in), or its refused state for a link that is used, expired or unknown.
 */
export const FORGOT_COPY = {
  /** The link under sign-in's panel. */
  link: "Forgot password?",
  href: "/forgot",
  title: "Reset password",
  submit: "Send link",
  submitSending: "Sending…",
  /** The confirmation, the same for every address. */
  sentTitle: "Check your email",
  sentText: (email: string) =>
    `If an account uses ${email}, a link to set a new password is on its way. It works for 1 hour.`,
  back: "Back to sign in",
  invalid: "Enter your email address.",
  failed: "Could not send the link. Try again.",
} as const;

export const RESET_COPY = {
  title: "Set a new password",
  label: "New password",
  submit: "Save password",
  submitSending: "Saving…",
  short: "Enter a password of at least 8 characters.",
  failed: "Could not save the password. Try again.",
  /** Saved: every session of the account ended; sign in with the new one. */
  doneTitle: "Password changed",
  doneText: "Your password is changed and you are signed out everywhere. Sign in with the new one.",
  signIn: "Sign in",
  /** A link that is used, expired or unknown. */
  refusedTitle: "Link no longer works",
  refusedText: "This link was used already or has expired. Ask for a new one.",
  again: "Reset password",
} as const;
