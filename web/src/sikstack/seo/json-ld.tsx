import { SITE } from "@/content";
import { LANDING } from "@/content/marketing";

import { homeUrl } from "./urls";

/**
 * P87 — the landing's structured data (schema.org, JSON-LD): one block holding the Organization
 * (sikstack, its site, and its GitHub repo as `sameAs`) and the SoftwareApplication (the Claude Code
 * plugin and its web app). Only what the page itself says: its name, description, requirements and
 * where it installs. No `offers`, rating or any figure (the landing states none, F262).
 *
 * Rendered as a plain `<script type="application/ld+json">`, as the Next.js JSON-LD guide recommends; it
 * is data, never executed, so the reader CSP's nonce does not apply. Every `<` is written as its JSON
 * unicode escape (`jsonLdText`), so no string in it can close the script early.
 */

const ORG_ID = `${homeUrl()}/#organization`;

type Needs = (typeof LANDING.install.needs)[number];

export function siteJsonLd() {
  const repo = LANDING.footer.github.href;
  const requirements = LANDING.install.needs
    .map((p: Needs) => (typeof p === "string" ? p : p.code))
    .join("")
    .replace(/^Needs /, "")
    .replace(/\.$/, "");
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": ORG_ID,
        name: SITE.name,
        url: homeUrl(),
        sameAs: [repo],
      },
      {
        "@type": "SoftwareApplication",
        name: SITE.name,
        description: LANDING.meta.description,
        url: homeUrl(),
        applicationCategory: "DeveloperApplication",
        softwareRequirements: requirements,
        installUrl: repo,
        publisher: { "@id": ORG_ID },
      },
    ],
  };
}

/** `value` as an inline script's text: JSON with every `<` escaped. */
export function jsonLdText(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** The landing's one JSON-LD block. */
export function SiteJsonLd() {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: jsonLdText(siteJsonLd()) }}
    />
  );
}
