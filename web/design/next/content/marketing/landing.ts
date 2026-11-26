// The public landing at `/`: every word and link it shows. The page (src/sikstack/landing/) holds no copy of its own.
// Applied, this file is `src/content/marketing/landing.ts` (P83-8k.S1's design: the landing around the plugin).
//
// - sikstack is offered one way for now, the `sikstack@sikstack` Claude Code plugin; the page says what it does in
//   Claude Code (the README's first paragraph, `platform/README.md`), gives the three install commands and
//   `sik-mode`, then the sign-in path to the web parts the plugin feeds: the Workspace and Design.
// - Off the page, still in the app: the Library, Feedback; off every user surface: the CLI install, the REST
//   variables and the org key (the old Connect section), and the Codex, REST and MCP mentions.
// - The commands are the fixture's `SKX.commands` (job 09), literal.
// - The picture's Workspace rows are the frame's fixture F13, verbatim (as the old hero drew them); its Design rows
//   are the design build's sample recording (`web/design/data/sample/recording.json`, `design.builds` 1 and 2).
// - Not said here (F262): a price, tiers, the retrieval API, figures, logos, quotes.

const REPO = "https://github.com/leetusik/sikstack";

export const LANDING_LINKS = {
  signIn: "/login",
  createAccount: "/signup",
  /** A signed-in visitor's way on (P78, F8): the web part and the header lead here instead of sign-in. */
  dashboard: "/dashboard",
} as const;

/** The page's two parts: the header's and footer's links. */
export const LANDING_PARTS = [
  { id: "install", label: "Install" },
  { id: "web", label: "On the web" },
] as const;

export type LandingStatus = "idle" | "live" | "active" | "done";

export const LANDING = {
  meta: {
    title: "sikstack — A phase-and-slice workflow for Claude Code",
    description:
      "A Claude Code plugin: the agent plans your change as a phase, cuts it into slices, runs and reviews each one, and stops for you before it lands.",
    siteName: "sikstack",
  },
  wordmark: "sikstack",
  header: {
    nav: "Landing",
    signIn: "Sign in",
    createAccount: "Create account",
    /** Signed in (P78, F8): in place of Sign in and Create account. */
    dashboard: "Dashboard",
    menu: "Menu",
    skip: "Skip to content",
  },
  /** First on the page: what sikstack does, and the install beside it. */
  hero: {
    title: "A phase-and-slice workflow for Claude Code.",
    lede: "Ask for a change. The agent writes it up as a phase, cuts it into slices, runs and reviews each one, and stops for you to check the result before it lands.",
    noAccount:
      "No account needed. Setup asks for an email; your work stays on your machine.",
    needs: [
      "Needs Claude Code, ",
      { code: "git" },
      ", and ",
      { code: "python3" },
      " 3.8 or later.",
    ],
    repo: { label: "The plugin on GitHub", href: REPO },
  },
  /** The install steps (job 09's block, moved into the hero): the plugin's three commands, then how work starts. */
  install: {
    label: "Install sikstack in Claude Code",
    steps: [
      {
        n: "1",
        title: "Add the marketplace",
        command: "/plugin marketplace add leetusik/sikstack",
        what: "Marketplace command",
      },
      {
        n: "2",
        title: "Install the plugin",
        command: "/plugin install sikstack@sikstack",
        what: "Plugin install command",
      },
      {
        n: "3",
        title: "Set up, once per machine",
        command: "/sikstack:setup",
        what: "Setup command",
      },
    ],
    work: {
      title: "Then start working, in any git repository",
      command: "/sikstack:sik-mode",
      what: "sik-mode command",
    },
  },
  /** Last: sign in to see it on the web, the parts the plugin feeds today. */
  web: {
    title: "Your work on the web",
    textBefore: "Run ",
    command: "/sikstack:sign-in",
    textAfter:
      " in Claude Code and confirm its code here. Your phases then show in the Workspace, and the design builds you publish in Design.",
    createAccount: "Create account",
    signIn: "Sign in",
    /** Signed in (P78, F8): in place of Create account and Sign in. */
    dashboard: "Open dashboard",
    picture: {
      label:
        "A project in sikstack, platform: its phases in the Workspace, and the design builds published from it in Design.",
      org: "Personal",
      project: "platform",
      visibility: "Private",
      workspace: {
        title: "Workspace",
        meta: "12 on the agenda",
        phases: [
          {
            id: "P57",
            name: "sikstack design",
            word: "In progress",
            status: "live",
            count: "1/7",
          },
          {
            id: "P58",
            name: "Project switcher and org home",
            word: "Planned",
            status: "idle",
            count: "0/5",
          },
          {
            id: "P56",
            name: "One platform at sikstack.com",
            word: "In review",
            status: "active",
            count: "6/6",
          },
        ],
      },
      design: {
        title: "Design",
        meta: "5 builds",
        builds: [
          {
            commit: "54a2288",
            branch: "feat/design-service",
            shared: true,
            word: "Shared",
            when: "Nov 20",
          },
          {
            commit: "19ba502",
            branch: "main",
            shared: false,
            word: "Not shared",
            when: "Nov 20",
          },
        ],
      },
    },
  },
  footer: {
    nav: "Footer",
    github: { label: "GitHub", href: REPO },
  },
} as const;
