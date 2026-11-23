/**
 * The Design service's words (P77): the project's list of design builds and a build's viewer. A viewer only:
 * no comment, pick, sign-off, edit, delete or publish on the web (publishing and deleting are the CLI's).
 */
export const DESIGN = {
  title: "Design",
  /** The list's count line, at the head's end. */
  count: (n: number) => (n === 1 ? "1 build" : `${n.toLocaleString("en-US")} builds`),
  columns: {
    build: "Build",
    branch: "Branch",
    recording: "Recording",
    size: "Size",
    share: "Sharing",
    published: "Published",
  },
  /** The recording a build was made from: the sample, or a real project's (`design/data/local/`), private. */
  sample: "Sample data",
  private: "Private",
  /** A build made from a tree with uncommitted changes. */
  dirty: "Uncommitted changes",
  clean: "Clean",
  shared: "Shared",
  notShared: "Not shared",
  /** No builds yet: why, and what to do. */
  none: { before: "No design builds yet. Publish one from a session with ", command: "sikstack design-publish", after: "." },
  /** A build's name: its commit, short; the id's head when the build has no commit. */
  buildTitle: (short: string) => `Build ${short}`,
  back: "Design",
  facts: {
    branch: "Branch",
    tree: "Tree",
    recording: "Recording",
    size: "Size",
    published: "Published",
  },
  files: (n: number) => (n === 1 ? "1 file" : `${n.toLocaleString("en-US")} files`),
  share: {
    label: "Share link",
    off: "Off",
    turnOn: "Turn on",
    turnOff: "Turn off",
    turningOn: "Turning on",
    turningOff: "Turning off",
    copyLabel: "Copy share link",
    /** A private build: the one line, in place of the control. */
    refused: (file: string) => `Made from a private recording (${file}), so it cannot be shared.`,
  },
  options: {
    title: "Options",
    count: (n: number) => `${n} directions`,
  },
  pages: {
    title: "Pages",
    count: (n: number) => (n === 1 ? "1 page" : `${n} pages`),
  },
  /** A page's or a direction's name, its link: it opens the build on its own host, in a new tab. */
  opensLabel: (name: string) => `${name}, opens in a new tab`,
  gone: {
    title: "Build not found",
    text: (project: string) => `This build was deleted, or it isn’t part of ${project}.`,
  },
} as const;
