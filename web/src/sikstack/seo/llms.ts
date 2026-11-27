import { SITE } from "@/content";
import { LANDING } from "@/content/marketing";

import { absoluteUrl, homeUrl } from "./urls";

/**
 * P87 — `/llms.txt` (`app/llms.txt/route.ts`), in the llmstxt.org shape: the name as the H1, a
 * blockquote summary, detail blocks with no heading (what sikstack is, then the install), then H2
 * sections of links, the last one `Optional`.
 *
 * Every sentence and command is the landing's own (`LANDING`, `SITE.description`), never retyped, so the
 * file cannot drift from the page; only the link names and their notes are this file's.
 */

type Needs = (typeof LANDING.install.needs)[number];

/** The install's requirement line, its `{ code }` parts in backticks. */
function needsLine(parts: readonly Needs[]): string {
  return parts
    .map((p) => (typeof p === "string" ? p : `\`${p.code}\``))
    .join("");
}

const REPO = LANDING.footer.github.href;

export const LLMS_LINKS = {
  heading: "Links",
  optional: "Optional",
  items: [
    { name: "sikstack", href: homeUrl(), note: "the landing" },
    {
      name: LANDING.install.repo.label,
      href: REPO,
      note: "its source, install and changelog",
    },
    {
      name: "Issues",
      href: `${REPO}/issues`,
      note: "report a problem or ask for a change",
    },
  ],
  more: [
    {
      name: "Sitemap",
      href: absoluteUrl("/sitemap.xml"),
      note: "every public page, with the Library’s Public documents and books",
    },
  ],
} as const;

/** The whole file. */
export function llmsText(): string {
  const { install } = LANDING;
  const link = (l: { name: string; href: string; note: string }) =>
    `- [${l.name}](${l.href}): ${l.note}`;
  const lines = [
    `# ${SITE.name}`,
    "",
    `> ${SITE.description}`,
    "",
    `${LANDING.hero.title} ${LANDING.how.text}`,
    "",
    `- ${LANDING.workspace.title}: ${LANDING.workspace.text}`,
    `- ${LANDING.library.title}: ${LANDING.library.text}`,
    `- ${LANDING.feedback.title}: ${LANDING.feedback.text}`,
    "",
    `${install.title}. ${needsLine(install.needs)}`,
    "",
    ...install.steps.map((s) => `${s.n}. ${s.title}: \`${s.command}\``),
    "",
    `${install.work.title}: \`${install.work.command}\``,
    "",
    `${install.noAccount} ${install.signInBefore}\`${install.signIn}\`${install.signInAfter}`,
    "",
    `## ${LLMS_LINKS.heading}`,
    "",
    ...LLMS_LINKS.items.map(link),
    "",
    `## ${LLMS_LINKS.optional}`,
    "",
    ...LLMS_LINKS.more.map(link),
    "",
  ];
  return lines.join("\n");
}
