import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LANDING, LANDING_LINKS } from "@/content/marketing";
import { Landing } from "@/sikstack/landing/landing";

// The landing at `/` (job 06, round 01-landing, signed): what its words and links must and must
// not say, and how its sheet stays scoped. The suite has no DOM, so it reads the content module
// the page renders from and the page's own source files; the diagram's section (job 08) is read
// from the page rendered to static markup.

const WEB = join(__dirname, "..");
const SOURCES = [
  "src/sikstack/landing",
  "src/app/(marketing)",
  "src/content/marketing",
].flatMap((dir) =>
  readdirSync(join(WEB, dir))
    .filter((f) => /\.(tsx?|css)$/.test(f))
    .map((f) => ({
      path: `${dir}/${f}`,
      text: readFileSync(join(WEB, dir, f), "utf8"),
    })),
);

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(strings);
  return [];
}

const WORDS = strings({ LANDING, LANDING_LINKS });

// Operator decision D5: the record's `[GITHUB URL]` placeholder.
const REPO = "https://github.com/leetusik/sikstack";

describe("the landing's links", () => {
  it("never carry the placeholder [GITHUB URL]", () => {
    expect(WORDS.filter((w) => w.includes("[GITHUB URL]"))).toEqual([]);
    for (const { path, text } of SOURCES)
      expect(text.includes("[GITHUB URL]"), path).toBe(false);
  });

  it("send the install's plugin link and the footer's GitHub to the repository", () => {
    expect(LANDING.install.repo.href).toBe(REPO);
    expect(LANDING.footer.github.href).toBe(REPO);
    expect(WORDS.filter((w) => w.includes("github.com"))).toEqual([REPO, REPO]);
  });

  it("are written only in the content module, never in the page's code", () => {
    for (const { path, text } of SOURCES.filter(
      (s) => !s.path.startsWith("src/content/"),
    ))
      expect(/github\.com/.test(text), path).toBe(false);
  });
});

describe("the landing's words (F262)", () => {
  const banned = [
    /get started/i,
    /retrieval api/i,
    /\bpric(e|es|ing)\b/i,
    /\bper month\b|\/mo\b/i,
    /\$\s?\d|₩|€|£/,
    /\btiers?\b/i,
  ];

  it("say no price, no tier, no Get started and no retrieval API", () => {
    for (const re of banned) {
      expect(
        WORDS.filter((w) => re.test(w)),
        String(re),
      ).toEqual([]);
      for (const { path, text } of SOURCES.filter((s) =>
        s.path.endsWith(".tsx"),
      ))
        expect(re.test(text), `${path} ${re}`).toBe(false);
    }
  });

  it("call the sign-up action Create account", () => {
    expect(LANDING.header.createAccount).toBe("Create account");
    expect(LANDING.hero.createAccount).toBe("Create account");
    expect(LANDING_LINKS.createAccount).toBe("/signup");
    expect(LANDING_LINKS.signIn).toBe("/login");
  });
});

describe("Connect (the plugin's sign-in, the only way to link Claude Code)", () => {
  const html = renderToStaticMarkup(createElement(Landing));
  const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
  const at = main.indexOf('id="connect"');
  const block = at < 0 ? "" : main.slice(at, main.indexOf("</section>", at));

  it("says its words: sign in from the repo, then confirm on the web", () => {
    expect(LANDING.connect).toEqual({
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
    });
    expect(block).toContain("Connect Claude Code</h2>");
    expect(block).toContain('<h3 class="lp-h3">Sign in, in the repo</h3>');
    expect(block).toContain(
      '<pre class="lp-cmd-value" tabindex="0" aria-label="Sign-in command"><code>/sikstack:sign-in</code></pre>',
    );
    expect(block).toContain('<h3 class="lp-h3">Confirm on the web</h3>');
    expect(block).not.toMatch(/<a\b/);
  });

  it("offers no other path: no CLI install, no API variables, no other agent, REST or MCP", () => {
    const off = [/install\.sh/, /KB_API/, /codex/i, /speaks REST/i, /\bMCP\b/, /org key/i];
    for (const re of off) {
      expect(WORDS.filter((w) => re.test(w)), String(re)).toEqual([]);
      expect(re.test(main), `markup ${re}`).toBe(false);
    }
    expect("mintOrgKey" in LANDING_LINKS).toBe(false);
  });

  it("keeps the explain skill off the landing (job 09)", () => {
    expect(WORDS.filter((w) => /explain/i.test(w))).toEqual([]);
  });
});

describe("the install section (job 09, round 01, `## Build` *The landing's block (S5)*)", () => {
  const html = renderToStaticMarkup(createElement(Landing));
  const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
  const ids = [...main.matchAll(/<section\b[^>]*\bid="([\w-]+)"/g)].map(
    (m) => m[1],
  );
  const at = main.indexOf('id="install"');
  const block = at < 0 ? "" : main.slice(at, main.indexOf("</section>", at));

  it("sits between the Workspace and the Library, labelled by its h2", () => {
    expect(ids).toEqual(["workspace", "install", "library", "feedback", "connect"]);
    expect(block).toContain('aria-labelledby="lp-inst"');
    expect(block).toContain(
      '<h2 class="lp-h2 lp-inst-h2" id="lp-inst">Install sikstack in Claude Code</h2>',
    );
  });

  it("says its three sentences and links the repository in a new tab", () => {
    expect(block).toContain(
      "<p>No account needed. Setup asks for an email; your work stays on your machine.</p>",
    );
    expect(block).toContain(
      '<p>To see it on the web, sign in later with <span class="lp-code-inline">/sikstack:sign-in</span>.</p>',
    );
    expect(block).toContain(
      '<p>Needs Claude Code, <span class="lp-code-inline">git</span>, and <span class="lp-code-inline">python3</span> 3.8 or later.</p>',
    );
    expect(block).toContain(
      `<a class="link link-row" href="${REPO}" target="_blank" rel="noopener noreferrer">The plugin on GitHub</a>`,
    );
  });

  it("numbers the three steps, then how work starts, each command copied whole", () => {
    const steps = [
      ["1", "Add the marketplace", "/plugin marketplace add leetusik/sikstack", "Marketplace command"],
      ["2", "Install the plugin", "/plugin install sikstack@sikstack", "Plugin install command"],
      ["3", "Set up, once per machine", "/sikstack:setup", "Setup command"],
      ["", "Then start working", "/sikstack:sik-mode", "sik-mode command"],
    ];
    const items = [...block.matchAll(/class="lpi-step">([\s\S]*?)<\/h3>[\s\S]*?<pre class="lp-cmd-value" tabindex="0" aria-label="([^"]+)"><code>([^<]+)<\/code><\/pre><button[^>]*aria-label="([^"]+)"/g)];
    expect(
      items.map((m) => [
        /<span class="lpi-n" aria-hidden="true">([^<]*)<\/span>/.exec(m[1])?.[1] ?? "",
        /<h3 class="lp-h3">(.*)$/.exec(m[1])?.[1],
        m[3],
        m[2],
      ]),
    ).toEqual(steps);
    expect(items.map((m) => m[4])).toEqual([
      "Copy marketplace command",
      "Copy plugin install command",
      "Copy setup command",
      "Copy sik-mode command",
    ]);
    expect(block).toMatch(/<ol class="lpi-steps">(<li class="lpi-step">[\s\S]*?<\/li>){3}<\/ol>/);
  });

  it("drops the Workspace's Coming mark everywhere and keeps the Library's", () => {
    const ws = main.slice(main.indexOf('id="workspace"'), main.indexOf('id="install"'));
    expect(ws).not.toContain("Coming");
    const how = main.slice(main.indexOf('aria-labelledby="lp-how"'), main.indexOf('id="workspace"'));
    expect(how).not.toContain("Coming");
    expect(LANDING.how.label).not.toMatch(/coming/i);
    const lib = main.slice(main.indexOf('id="library"'), main.indexOf('id="feedback"'));
    expect(lib).toContain("Coming");
  });
});

describe("the landing's sheet", () => {
  const css = readFileSync(
    join(WEB, "src/sikstack/landing/landing.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  /** What is left of the sheet once its `@scope (.ui) to ([data-ui-legacy])` blocks and keyframes are cut out. */
  function outsideScope(text: string): string {
    let rest = "";
    let i = 0;
    while (i < text.length) {
      const at = text.slice(i);
      const m =
        /^@(scope \(\.ui\) to \(\[data-ui-legacy\]\)|keyframes [\w-]+)\s*\{/.exec(
          at,
        );
      if (m) {
        let depth = 0;
        let j = i + m[0].length - 1;
        for (; j < text.length; j++) {
          if (text[j] === "{") depth++;
          else if (text[j] === "}" && --depth === 0) break;
        }
        i = j + 1;
        continue;
      }
      rest += text[i];
      i++;
    }
    return rest;
  }

  it("holds every rule inside its @scope block (keyframes aside)", () => {
    expect(css).toMatch(/@scope \(\.ui\) to \(\[data-ui-legacy\]\)/);
    expect(outsideScope(css).trim()).toBe("");
  });

  it("names no hex colour", () => {
    expect(css.match(/#[0-9a-f]{3,8}\b/gi)).toBeNull();
  });
});

describe("the diagram's section (job 08, round 01, `## Build` 3a-3b)", () => {
  // The page rendered to static markup: where the section sits and what its figure holds.
  const html = renderToStaticMarkup(createElement(Landing));
  const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
  const sections = [...main.matchAll(/<section\b[^>]*>/g)].map((m) => m[0]);
  const at = main.indexOf('aria-labelledby="lp-how"');
  const how = at < 0 ? "" : main.slice(at, main.indexOf("</section>", at));
  const figure = how.slice(how.indexOf("<figure"), how.indexOf("</figure>"));
  const words = LANDING.how;

  it("is the second section, after the hero, with its h2", () => {
    expect(sections[0]).toContain('aria-labelledby="lp-h1"');
    expect(sections[1]).toContain('aria-labelledby="lp-how"');
    expect(sections[2]).toContain('aria-labelledby="lp-ws"');
    expect(how).toContain(`<h2 class="lp-h2" id="lp-how">${words.title}</h2>`);
  });

  it("draws a figure with role img, labelled from the content module", () => {
    expect(figure).toMatch(/^<figure class="lp-map" role="img"/);
    expect(figure).toContain(`aria-label="${words.label}"`);
  });

  it("holds nothing to click or focus", () => {
    expect(figure).toContain("lp-map-chain");
    expect(figure).not.toMatch(/<a\b|<button\b|tabindex/i);
  });
});
