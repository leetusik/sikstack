import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";

import { LANDING } from "@/content/marketing";
import { SITE } from "@/content";

// P87 — `/llms.txt` (llmstxt.org): served as plain text, outside the proxy, holding every install command the
// landing shows, verbatim; and robots still keeps the private surface out of crawls.

/** Every command the landing's install and connect sections show. */
const COMMANDS = [
  ...LANDING.install.steps.map((s) => s.command),
  LANDING.install.work.command,
  LANDING.install.signIn,
  LANDING.connect.signIn.command,
];

describe("/llms.txt", () => {
  it("serves 200 text/plain in the llmstxt.org shape", async () => {
    const { GET, dynamic } = await import("@/app/llms.txt/route");
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(dynamic).toBe("force-static");
    const text = await res.text();
    const lines = text.split("\n");
    expect(lines[0]).toBe(`# ${SITE.name}`);
    expect(lines[2]).toBe(`> ${SITE.description}`);
    // H2 link sections, the last one `Optional`, each item a Markdown link.
    const h2 = lines.filter((l) => l.startsWith("## "));
    expect(h2).toEqual(["## Links", "## Optional"]);
    expect(lines.filter((l) => /^#\s/.test(l))).toHaveLength(1);
    const links = text.slice(text.indexOf("## Links"));
    for (const l of links.split("\n").filter((l) => l.startsWith("- ")))
      expect(l).toMatch(/^- \[[^\]]+\]\((https?:\/\/[^)]+)\): \S/);
    expect(links).toContain(`(${LANDING.footer.github.href})`);
    expect(links).toContain(`(${LANDING.footer.github.href}/issues)`);
  });

  it("holds every install command in LANDING, verbatim", async () => {
    const { GET } = await import("@/app/llms.txt/route");
    const text = await GET().text();
    expect(COMMANDS.length).toBeGreaterThanOrEqual(5);
    for (const command of COMMANDS) expect(text).toContain(`\`${command}\``);
  });

  it("is not caught by the proxy, which still runs on the pages", async () => {
    const { config } = await import("@/proxy");
    const runs = (url: string) => unstable_doesMiddlewareMatch({ config, url });
    expect(runs("/llms.txt")).toBe(false);
    expect(runs("/robots.txt")).toBe(false);
    expect(runs("/sitemap.xml")).toBe(false);
    expect(runs("/")).toBe(true);
    expect(runs("/@acme/lab/notes")).toBe(true);
  });
});

describe("robots", () => {
  it("still disallows the private surface and names the sitemap", async () => {
    const { default: robots } = await import("@/app/robots");
    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    expect(rules.disallow).toEqual(
      expect.arrayContaining([
        "/dashboard",
        "/projects",
        "/login",
        "/signup",
        "/api/",
      ]),
    );
    expect(r.sitemap).toBe(`${SITE.url}/sitemap.xml`);
  });
});

describe("the descriptions", () => {
  it("say what sikstack is, under 160 characters, with no figure; the hero keeps its words", () => {
    for (const d of [SITE.description, LANDING.meta.description]) {
      expect(d).toMatch(/Claude Code plugin/);
      expect(d.length).toBeLessThanOrEqual(160);
      expect(d).not.toMatch(/\d|\$|€|“|"/);
    }
    // The hero's visible words stay as they were.
    expect(LANDING.hero.title).toBe(
      "One place for your project’s work with its coding agents.",
    );
    expect(LANDING.hero.lede).toBe(
      "What your agents plan and run, what they write for you to read, and what your users said about it.",
    );
  });
});
