import type { ItemShare } from "@/lib/sharing/model";
/**
 * What the book page draws (sikstack Library, job 03 round 02, `## Build` § Page: book, its *Data shapes*):
 * the plain, serialisable view the loader builds from the reads and the components render. Every href is
 * already built (`reader-href.ts`, with the way back carried on by `withFrom`) and every sentence already
 * written (`@/content/book-page`); no component computes either.
 */
import type { StatusState } from "@/sikstack/ui";

import type { Viewer } from "./model";

/** A reading state's word and its shape (frame.md F54). */
export interface StateView {
  word: string;
  status: StatusState;
}

/** BookHead: `{ title, sub, description, member, place, word, cls, pct, count }`. */
export interface HeadView {
  title: string;
  /** The second title, or "" when the read carries none (drawn only when present). */
  sub: string;
  /** Its `lang`: the manifest's, else `ko` for a Korean one, else unset (P63, D248-j7). */
  subLang?: string;
  description: string;
  /** `Codebase book in platform`; for anyone outside the org `… in @org / project`. */
  place: string;
  /** Whether the reader's state is saved (signed in): the state and the track, else the count and the line. */
  member: boolean;
  state: StateView;
  /** Finished ÷ chapters, 0 to 100. */
  pct: number;
  /** `14 chapters`. */
  count: string;
}

export type ContMode = "continue" | "next" | "start" | "finished";

/** BookContinue: `{ mode, name, title, facts[], lede, action, primary, chapter }`. */
export interface ContView {
  mode: ContMode;
  /** The panel's name: `Continue reading`, `Next chapter`, `Start reading`, `Finished`. */
  name: string;
  title: string;
  /** The language of the title and lede (a chapter's), or null for the page's own words. */
  lang: string | null;
  facts: string[];
  lede: string;
  action: string;
  primary: boolean;
  href: string;
}

export interface VersionRowView {
  n: number;
  current: boolean;
  /** `Published Oct 28`, or "" when the read carries no date. */
  published: string;
  /** True when that date is a one-time best-effort fill (P63): data only, drawn as a plain date. */
  bestEffort?: boolean;
  /** `Translated from English v2`, on the newest row of a translation; else "". */
  from: string;
  aria: string;
  href: string;
}

export interface VersionGroupView {
  code: string;
  label: string;
  rows: VersionRowView[];
}

export interface LangLinkView {
  code: string;
  /** `English v3`. */
  label: string;
  aria: string;
  stale: boolean;
  href: string;
}

/** A chapter's row: `{ id, n, title, word, cls, hasState, updated, groups }` and what the row draws of them. */
export interface RowView {
  key: string;
  n: number;
  title: string;
  lang: string;
  href: string;
  updated: boolean;
  /** None for a visitor. */
  state: StateView | null;
  /** The language links, when the chapter has two or more languages. */
  langs: LangLinkView[];
  /** One language with an earlier version: `v2, published Oct 28`; else "". */
  one: string;
  /** Some language has an earlier version: Version history is drawn. */
  multiVer: boolean;
  groups: VersionGroupView[];
}

export interface BookView {
  org: string;
  project: string;
  slug: string;
  title: string;
  viewer: Viewer;
  signedIn: boolean;
  head: HeadView;
  cont: ContView;
  /** The way on once the book's reading data is cleared: chapter 1, `start`. */
  start: ContView;
  /** The notes row (`13 items in 4 chapters`), only for a reader whose book has marks. */
  notes: { href: string; line: string } | null;
  /** `14 chapters`, the Contents' meta. */
  count: string;
  /** The shape note under Contents, or "". */
  shapeNote: string;
  rows: RowView[];
  /** Your reading data: what a clear removes; null when there is none (or nobody signed in). */
  data: { chapters: number; marks: number } | null;
  /** The bar's way back (F324): `Library`, a project's name, or the org's name. */
  back: { href: string; label: string };
  /** Where the wordmark goes. */
  homeHref: string;
  signInHref: string;
  /** The book's sharing for a member (P75; it covers every chapter), null for anyone else. */
  share: ItemShare | null;
}
