// The public landing at `/`: every word and link it shows (job 06, round 01-landing, signed; its
// `## Build` and the ledger F250 to F264). The page (src/sikstack/landing/) holds no copy of its own.
//
// Applied, this file is `src/content/marketing/landing.ts`. P83-8k.S1's design (the landing offers only the Claude
// Code plugin): `connect` is the plugin's sign-in in place of the CLI install, the two variables and the org key;
// `how.label`, `how.agent.line` and `feedback.text` no longer name Codex, REST or MCP; `LANDING_LINKS.mintOrgKey`
// is gone with the link that used it. Every other word is production's.
//
// - The picture's data is the frame's fixture F13, verbatim (platform's phases, documents, feedback and
//   counts; times as of its "now", Nov 15, 2026, 10:00), and the landing's made-up items F261.
// - The record's GitHub placeholder is operator decision D5: the install's plugin link and the footer's GitHub.
// - `how` (the diagram's section) is job 08, round 01-landing-diagram-feedback, signed: its `## Build`
//   3a and 3b, verbatim, less the Workspace's Coming mark (job 09).
// - `install` (the install section, between the Workspace and the Library) is job 09, round
//   01-install-and-connect, signed: its `## Build` *The landing's block (S5)*; the commands are the fixture's
//   `SKX.commands`, literal. Job 09 also drops the Workspace's Coming mark everywhere it showed.
// - `connect` (P83-8k.S1): the plugin's `/sikstack:sign-in` and its connect page, in the words of
//   `plugins/sikstack/skills/sign-in/SKILL.md` (the code to check, the Connect button).
// - Not said here (F262): a price, tiers, the retrieval API, figures, logos, quotes.

const REPO = "https://github.com/leetusik/sikstack";

export const LANDING_LINKS = {
  signIn: "/login",
  createAccount: "/signup",
  /** A signed-in visitor's way on (P78, F8): the header and the hero lead here instead of sign-in. */
  dashboard: "/dashboard",
} as const;

/** The four parts, in the app's rail order, then Connect (F250): the header's and footer's links. */
export const LANDING_PARTS = [
  { id: "workspace", label: "Workspace" },
  { id: "library", label: "Library" },
  { id: "feedback", label: "Feedback" },
  { id: "connect", label: "Connect" },
] as const;

export type LandingStatus = "idle" | "live" | "active" | "done";

export const LANDING = {
  meta: {
    title: "sikstack — One place for your project’s work with its coding agents",
    /** P87: what sikstack is, plainly, for search results (`SITE.description`'s line); the hero's words stay. */
    description:
      "sikstack is a Claude Code plugin and web app: what your coding agents plan and run, what they write for you to read, and your users’ feedback.",
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
  hero: {
    title: "One place for your project’s work with its coding agents.",
    lede: "What your agents plan and run, what they write for you to read, and what your users said about it.",
    createAccount: "Create account",
    signIn: "Sign in",
    /** Signed in (P78, F8): in place of Create account and Sign in. */
    dashboard: "Open dashboard",
  },
  /** The hero's picture: platform's overview (F13), static. */
  picture: {
    label:
      "A project in sikstack, platform: its phases in the Workspace, its documents in the Library, and what its users said in Feedback.",
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
    library: {
      title: "Library",
      meta: "132 documents",
      docs: [
        {
          title: "How capture deduplicates feedback",
          lang: "en",
          length: "6 min",
        },
        { title: "검색 색인을 다시 만드는 순서", lang: "ko", length: "4 min" },
        { title: "The platform handbook", lang: "en", length: "14 chapters" },
      ],
    },
    feedback: {
      title: "Feedback",
      meta: "23 this month",
      messages: [
        {
          rating: "3/5",
          text: "Search finds the page but not the paragraph I was after.",
          when: "2h ago",
        },
        {
          rating: "2/5",
          text: "On my phone the top bar runs off the screen.",
          when: "3d ago",
        },
        {
          rating: "4/5",
          text: "Let me export my highlights to Markdown.",
          when: "6d ago",
        },
      ],
    },
  },
  /** The diagram's section, second on the page (job 08): how the parts fit together. */
  how: {
    title: "How the parts fit together",
    text: "Feedback becomes work in the Workspace; finished work becomes documents in the Library.",
    label:
      "How the parts of sikstack fit together. Feedback is what your users said; a piece of it becomes an agenda item in the Workspace. Your coding agent, Claude Code with the sikstack plugin, works the agenda, and the Workspace syncs from the agent’s workspace. The agent writes what it made to the Library, as books and documents for you to read.",
    feedback: { name: "Feedback", line: "What your users said" },
    toWorkspace: "A piece becomes an agenda item",
    workspace: { name: "Workspace", line: "The agenda and its phases" },
    toAgent: "Works the agenda",
    agent: {
      name: "Your coding agent",
      line: "Claude Code, with the sikstack plugin",
    },
    toLibrary: "Writes what it made",
    library: { name: "Library", line: "Books and documents" },
  },
  workspace: {
    title: "Workspace",
    text: "What your agents plan and run: an agenda of things to deal with, the phases each one becomes, their slices and verdicts, and the project’s docs. It syncs from your agents’ workspace.",
    picture: {
      label:
        "The agenda of the project platform: one item is now phase P57, in progress; one is open; one is solved.",
      title: "Agenda",
      meta: "12 items",
      fromFeedback: "From feedback",
      items: [
        {
          title: "On my phone the top bar runs off the screen",
          fromFeedback: true,
          phase: "P57",
          word: "In progress",
          status: "live",
        },
        {
          title: "Search finds the page, not the paragraph",
          fromFeedback: true,
          phase: null,
          word: "Open",
          status: "idle",
        },
        {
          title: "Retire the old docs site",
          fromFeedback: false,
          phase: null,
          word: "Solved",
          status: "done",
        },
      ],
    },
  },
  /** The install section (job 09): the plugin's three commands, then how work starts. */
  install: {
    title: "Install sikstack in Claude Code",
    noAccount:
      "No account needed. Setup asks for an email; your work stays on your machine.",
    signInBefore: "To see it on the web, sign in later with ",
    signIn: "/sikstack:sign-in",
    signInAfter: ".",
    needs: [
      "Needs Claude Code, ",
      { code: "git" },
      ", and ",
      { code: "python3" },
      " 3.8 or later.",
    ],
    repo: { label: "The plugin on GitHub", href: REPO },
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
      title: "Then start working",
      command: "/sikstack:sik-mode",
      what: "sik-mode command",
    },
  },
  library: {
    title: "Library",
    text: "What your agents wrote for you to read: books and documents, grounded in the code.",
    facts: [
      "Read it like a book, listen to it, or review it with a quiz.",
      "Search across English and Korean.",
      "Make a project’s documents public, in your org’s public library.",
    ],
    assistant:
      "Ask about a passage: the assistant answers from the document, the repository and the web.",
    coming: "Coming",
    picture: {
      label:
        "A document of platform open in the reader, with a highlight and a note.",
      title: "How capture deduplicates feedback",
      project: "platform",
      length: "6 min",
      date: "Nov 14",
      tools: ["A−", "A+", "Listen"],
      before:
        "Capture keeps the first copy of a message and counts the rest. Two messages are one when they ",
      mark: "come from the same key and carry the same text",
      after: ", within ten minutes of each other.",
      noteLabel: "Your note",
      note: "Ten minutes covers the widget’s retries.",
    },
  },
  feedback: {
    title: "Feedback",
    text: "What your users said, captured from your product with a Capture only key. Search it, read it, and send a piece to the Workspace: it becomes an agenda item.",
    picture: {
      label:
        "A piece of feedback on platform, rated 2 of 5, sent to the Workspace, where it is on the agenda.",
      rated: "Rated 2/5",
      when: "3d ago",
      text: "On my phone the top bar runs off the screen.",
      onAgenda: "On the agenda",
      sent: "Sent Nov 13",
    },
  },
  /** The plugin's way to sikstack (P83-8k.S1): sign in from the repo, then confirm on the connect page. */
  connect: {
    title: "Connect Claude Code",
    text: "Sign in from a repo, and the plugin sends its work to sikstack.",
    signIn: {
      title: "Sign in, in the repo",
      what: "Sign-in command",
      command: "/sikstack:sign-in",
    },
    confirm: {
      title: "Confirm on the web",
      text: "Check that the page shows the same code, sign in or create an account, and press Connect.",
    },
  },
  footer: {
    nav: "Footer",
    github: { label: "GitHub", href: REPO },
  },
} as const;
