// ── sikstack's settings pages (P88-ms.S3's design) ────────────────────────────────────────────
// The words of Org settings (`/settings`), Project settings (`/projects/<id>/settings`), their delete dialogs,
// Members' Step down and role note, the rail's Settings and the org menu's line for a shared name. English chrome
// in sentence case; an org's or a project's name is data. Applied by P88-ms.S4.

export const SETTINGS = {
  /** The rail's entry in both forms (the org's and the project's). */
  rail: "Settings",
  org: {
    title: "Org settings",
    /** The danger zone's panel. */
    delete: {
      heading: "Delete org",
      open: "Delete",
      openLabel: (org: string) => `Delete ${org}`,
      text: (org: string) => `${org} and everything in it go for good, for every member. There is no trash.`,
    },
  },
  project: {
    title: "Project settings",
    visibility: { heading: "Visibility" },
    delete: {
      heading: "Delete project",
      open: "Delete",
      openLabel: (project: string) => `Delete ${project}`,
      text: (project: string) => `${project} and everything in it go for good. There is no trash.`,
    },
  },
  /** The delete dialogs (org and project): the name typed again, the API's refusals. */
  confirm: {
    title: (name: string) => `Delete ${name}?`,
    /** What the org's delete takes: its projects (`1 project`, `4 projects`) and who loses it (`3 members`). */
    orgText: (projects: string, one: boolean, members: string) =>
      `Its ${projects} and everything in ${one ? "it" : "them"} go for good, for all ${members}.`,
    /** What the project's delete takes (the operator's list, P88-ms intent). */
    projectText:
      "Its documents, books, design builds, feedback, the linked sikstack workspace and its API keys go with it.",
    /** "Type <name> to confirm", the name at weight 500. */
    typeBefore: "Type ",
    typeAfter: " to confirm",
    /** The typed name can no longer become the name (client), or the API's 409 `name`. */
    wrong: (name: string) => `Type ${name} exactly as shown.`,
    cancel: "Cancel",
    deleteOrg: "Delete org",
    deleteProject: "Delete project",
    deleting: "Deleting…",
    failed: (name: string) => `Could not delete ${name}. Try again.`,
    refused: {
      /** 409 `tenant_one`: the instance's own org (it holds `docs/` and the master token). */
      tenant_one: (org: string) => `${org} is this server's own org. It can't be deleted.`,
      /** 409 `install_feedback`: the org holds, or the project is, the server's install-feedback project. */
      install_feedback: (name: string) => `${name} receives this server's install feedback. It can't be deleted.`,
      /** 409 `tracked_path`: a tenant #1 project named like a folder of the site's sources. */
      tracked_path: (project: string) => `${project} shares its folder with the site's sources. It can't be deleted.`,
    },
    /** The toast where a delete lands (the next org's home; the org's home for a project). */
    deleted: (name: string) => `${name} deleted.`,
  },
  members: {
    /** The Members panel's head, now a panel of Org settings (the page's `h1` is Org settings). */
    heading: "Members",
    /** An owner's own row, beside Leave, when the org has another owner (P88-ms: `POST /app/members/{id}/member`). */
    stepDown: "Step down",
    stepDownLabel: (org: string) => `Step down to member of ${org}`,
    steppedDown: (org: string) => `You are a member of ${org} now.`,
    stepDownFailed: (org: string) => `Could not step down in ${org}. Try again.`,
    /** The API's 409 `last_owner`: an org keeps at least one owner. */
    stepDownLastOwner: (org: string) => `You can't step down: ${org} needs an owner. Make another member an owner first.`,
    /** The role note under the table: what each role can do (`server/app_api.py`, `server/orgs_api.py`). */
    roles: {
      owner: { name: "Owners", text: " manage people, the org's name, URL and keys, project visibility, and deletes." },
      member: { name: "Members", text: " make projects and their keys, and write documents, books, feedback and workspaces." },
    },
  },
  /** The org menu's second line for an org whose name another of the account's orgs has, with no public URL. */
  orgLine: {
    mine: "Owned by you",
    owned: (email: string) => `Owned by ${email}`,
  },
} as const;
