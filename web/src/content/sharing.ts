// The words of an item's sharing (a document or a book): the reader's switch (`ShareControl`), the project's
// default switch and the link's miss. Imported by its own path, never through `content/index.ts`.

export const SHARING = {
  label: "Sharing",
  states: {
    members: "Members",
    link: "Anyone with the link",
    public: "Public",
  },
  /** The short word on the switch itself. */
  short: { members: "Members", link: "Link", public: "Public" },
  /** One line under the switch: what the state means. */
  means: {
    members: "Only members of this org can read it.",
    link: "Anyone with the link can read it, signed out too. It is not listed anywhere.",
    public: "Anyone can read it, and it is listed in the org's public library.",
  },
  /** A chapter's sharing is its book's. */
  book: "This sets the whole book: every chapter shares the book's setting.",
  /** A member's switch: Public is the org owner's act (the API's `can_publish`), so its button is off. */
  ownerPublishes: "Only an owner of this org can make it Public. Link and Members are yours to set.",
  copyLabel: "Copy link",
  changing: "Changing",
  failed: "Could not change the sharing. Try again.",
  /** The project page's switch: only the default for new items. */
  projectDefault: {
    label: "New items",
    public: "New documents and books start Public.",
    private: "New documents and books start Members only.",
    note: "Changing this changes only what new items start as; each item keeps its own sharing.",
  },
  /** `/s/<token>` when the link is off or never was. */
  gone: {
    title: "Link not found",
    body: "This link is off or does not exist. Ask whoever shared it for a new one.",
    home: "Go to sikstack",
  },
} as const;
