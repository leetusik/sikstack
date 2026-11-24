// ── sikstack's connect page (job 09 *Install and connect*, round 01; P76) ─────────
// The words of `/connect?code=…`, verbatim from the signed boards (`ConnectColumn.dc.html`,
// `SignInCode.dc.html`, `InstallFacts.dc.html`; frame.md F500–F505 and F533), read by
// `src/app/(auth)/connect/`. "sikstack" is lower case; "Claude Code" is where commands are
// typed; "on the web" is what a connection gives.

/** The connect page's outcome titles (F533); the confirm's title is `CONNECT_COPY.title`. */
export const CONNECT_TITLES = {
  waitlisted: "Still on the waitlist",
  connected: "Connected",
  declined: "Not connected",
  already: "Already connected",
  other: "Connected to another account",
  expired: "This code no longer works",
} as const;

export const CONNECT_COPY = {
  /** The tab title. */
  pageTitle: "Connect this install",
  codeLabel: "Check that Claude Code shows this code",
  title: "Connect this install?",
  signedOut: "Sign in to connect this install and see its work on the web.",
  /**
   * Signed in: the new project (the repo folder's name, made unique in the org: `platform-2`
   * when `platform` is taken) and the org picked, each at weight 500.
   */
  signedIn: {
    before: "Connecting creates the project ",
    middle: " in ",
    after: ", and this install’s work shows there on the web.",
  },
  error: "Could not connect this install. Try again.",
  facts: {
    install: "Install",
    plugin: "Plugin",
    pluginValue: (version: string) => `sikstack ${version}`,
    setUp: "Set up",
    setupEmail: "Setup email",
  },
  /** Signed in: the account a Connect uses, right under the action pair, and the way to switch. */
  signedInAs: "Signed in as",
  useAnotherAccount: "Use another account",
  org: "Org",
  createAccount: "Create account",
  signIn: "Sign in",
  decline: "Don’t connect",
  connect: "Connect",
  connecting: "Connecting…",
  signOut: "Sign out",
  /** Connected and Already connected: the way on, to the project's Workspace. */
  openProject: (project: string) => `Open ${project} on the web`,
  /** The sign-in command, named in a sentence (`.cmd-inline`). */
  command: "/sikstack:sign-in",
  /** The sign-in that frees an install from the account it is connected to (`.cmd-inline`). */
  releaseCommand: "/sikstack:sign-in release",
  outcomes: {
    waitlisted: {
      /** "Your account is still on the waitlist. We will email <address> when sikstack opens. Then run <command> in Claude Code again." */
      before: "Your account is still on the waitlist. We will email ",
      middle: " when sikstack opens. Then run ",
      after: " in Claude Code again.",
    },
    connected: (project: string) =>
      `Go back to Claude Code to finish. It uploads this repo’s earlier work to ${project}.`,
    declined: "Nothing changed. This install keeps working in Claude Code as before.",
    already: (project: string) =>
      `This install is already connected to this account. Its work shows in ${project} on the web.`,
    /** "This install is connected to another account. To connect it to this one, run <release command> in Claude Code on the install’s machine, then Connect the new code." */
    other: {
      before: "This install is connected to another account. To connect it to this one, run ",
      after: " in Claude Code on the install’s machine, then Connect the new code.",
    },
    /** "Run <command> in Claude Code again." */
    expired: { before: "Run ", after: " in Claude Code again." },
  },
} as const;
