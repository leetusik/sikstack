import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { buildPageIds, DESIGN_PART } from "./design-data";
import {
  AGENDA_STATES,
  DESIGN_BUILD_STATES,
  DESIGN_LIST_STATES,
  ITEM_STATES,
  type PageStates,
} from "./page-states";
import { PROJECT, RECORDING } from "./recording";

/**
 * The build's pages, one list: the front page (`app/page.tsx`) draws it with each page's states, and the manifest's
 * `pages` are written from it (`app/pages.json/route.ts`, read by `scripts/build.mjs`). A new page is one entry here,
 * its states one list in `page-states.ts`; the front page needs no edit. Server-only (build time).
 */
export interface BuildPage {
  name: string;
  /** Its route in the product. */
  route: string;
  /** The production route file it stands for, or null when production has none yet. */
  production: string | null;
  /** The path it opens at (its default state). */
  entry: string;
  /** Every path the build holds for it, when it has more than one. */
  entries?: string[];
  /** It reads the recording (the manifest names the file). */
  recording?: true;
  reads: string[];
  /** Its states, the first its default; null for a page without a state widget. */
  states: PageStates<string> | null;
}

const ws = `/projects/${encodeURIComponent(PROJECT)}/workspace/`;
const design = `/projects/${encodeURIComponent(PROJECT)}/design/`;
const recorded = RECORDING.workspace.agenda.map((a) => a.id);
const builds = buildPageIds();
// The viewer's entry is a build in its first state (no options: not private, not shared, no options page), so the
// page with no `state` shows the first state its widget lists; every other build page shows its own.
const plain = DESIGN_PART.builds.find((b) => !b.private && !b.share.on && !b.options)?.id ?? builds[0];

export const PAGES: readonly BuildPage[] = [
  {
    name: "Workspace · Agenda",
    route: "/projects/[projectId]/workspace",
    production: "src/app/(app)/projects/[projectId]/workspace/page.tsx",
    entry: ws,
    recording: true,
    reads: ["workspace"],
    states: AGENDA_STATES,
  },
  {
    name: "Agenda item",
    route: "/projects/[projectId]/workspace/agenda/[item]",
    production: "src/app/(app)/projects/[projectId]/workspace/agenda/[item]/page.tsx",
    entry: `${ws}agenda/${recorded[0]}/`,
    entries: recorded.map((id) => `${ws}agenda/${id}/`),
    recording: true,
    reads: ["workspace", "items"],
    states: ITEM_STATES,
  },
  {
    name: "Design",
    route: "/projects/[projectId]/design",
    production: null,
    entry: design,
    recording: true,
    reads: ["design.builds"],
    states: DESIGN_LIST_STATES,
  },
  {
    name: "Design build",
    route: "/projects/[projectId]/design/[build]",
    production: null,
    entry: `${design}${plain}/`,
    entries: builds.map((id) => `${design}${id}/`),
    recording: true,
    reads: ["design.details", "design.shareRefused", "design.gone"],
    states: DESIGN_BUILD_STATES,
  },
  {
    name: "System",
    route: "/system",
    production: null,
    entry: "/system/",
    reads: ["src/sikstack/styles/tokens.css", "@/sikstack/ui", "@/sikstack/frame", "@/sikstack/states", "@/sikstack/shell"],
    states: null,
  },
];

/** The front page itself, first in the manifest so the layout check walks it. */
export const INDEX_PAGE: BuildPage = {
  name: "All pages",
  route: "/",
  production: null,
  entry: "/",
  reads: ["lib/pages.ts", "lib/page-states.ts"],
  states: null,
};

/** The source the build was made from, as `scripts/build.mjs` reads it before `next build`; null when it did not. */
export function buildSource(): { commit: string; branch: string | null; dirty: boolean } | null {
  const commit = process.env.DESIGN_COMMIT;
  if (!commit) return null;
  return { commit, branch: process.env.DESIGN_BRANCH || null, dirty: process.env.DESIGN_DIRTY === "1" };
}

/** The options page, when the folder holds one (`templates/design/options.html`, copied into `public/` for a named
 * decision): its title, entry and directions, read from its `DIRECTIONS` as `scripts/build.mjs` reads them. */
export interface OptionsPage {
  name: string | null;
  entry: string;
  directions: { key: string; label: string; entry: string }[];
}

function* htmlUnder(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* htmlUnder(p);
    else if (name.endsWith(".html")) yield p;
  }
}

const quoted = (body: string, field: string) => {
  const m = new RegExp(`\\b${field}\\s*:\\s*(["'\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`).exec(body);
  return m ? m[2].replace(/\\(.)/g, "$1") : null;
};

export function optionsPage(): OptionsPage | null {
  // `next build design` runs from web/; a run from design/ finds it here.
  const here = existsSync(path.join(process.cwd(), "design", "next.config.ts"))
    ? path.join(process.cwd(), "design")
    : process.cwd();
  const pub = path.join(here, "public");
  if (!existsSync(pub)) return null;
  for (const file of htmlUnder(pub)) {
    const html = readFileSync(file, "utf8");
    const at = html.search(/\bconst\s+DIRECTIONS\s*=\s*\[/);
    if (at < 0) continue;
    const list = html.slice(at, html.indexOf("];", at) + 1);
    const rel = path.relative(pub, file).split(path.sep).join("/");
    const entry = rel === "index.html" || rel.endsWith("/index.html") ? `/${rel.slice(0, -"index.html".length)}` : `/${rel}`;
    const directions = [...list.matchAll(/\{[^{}]*\}/g)].flatMap(([object]) => {
      const key = quoted(object, "key");
      const label = quoted(object, "label");
      return key && label ? [{ key, label, entry: `${entry}?direction=${encodeURIComponent(key)}` }] : [];
    });
    if (directions.length === 0) continue;
    return { name: /<title>([^<]*)<\/title>/.exec(html)?.[1]?.trim() || null, entry, directions };
  }
  return null;
}
