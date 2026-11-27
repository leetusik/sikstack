import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LANDING } from "@/content/marketing";
import { jsonLdText } from "@/sikstack/seo/json-ld";

// P87 — `/` carries exactly one JSON-LD block: the Organization (sameAs the GitHub repo) and the
// SoftwareApplication, parsed from the page as rendered; `<` is escaped so no string closes the script.

vi.mock("next/server", async (orig) => ({
  ...(await orig<object>()),
  connection: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth-guards", () => ({
  optionalIdentity: vi.fn(async () => null),
}));

const BLOCK = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;

type Node = { "@type": string; [key: string]: unknown };

describe("the landing's JSON-LD", () => {
  it("is one block with the Organization and the SoftwareApplication", async () => {
    const { default: LandingPage } = await import("@/app/(marketing)/page");
    const html = renderToStaticMarkup(await LandingPage());
    const blocks = [...html.matchAll(BLOCK)].map((m) => m[1]);
    expect(blocks).toHaveLength(1);
    const data = JSON.parse(blocks[0]) as {
      "@context": string;
      "@graph": Node[];
    };
    expect(data["@context"]).toBe("https://schema.org");
    const byType = Object.fromEntries(
      data["@graph"].map((n) => [n["@type"], n]),
    );
    expect(Object.keys(byType).sort()).toEqual([
      "Organization",
      "SoftwareApplication",
    ]);
    expect(byType.Organization.sameAs).toContain(LANDING.footer.github.href);
    expect(byType.Organization.name).toBe("sikstack");
    expect(byType.SoftwareApplication.publisher).toEqual({
      "@id": byType.Organization["@id"],
    });
    // Only what the page says: no price, rating or made-up figure.
    for (const node of data["@graph"])
      for (const key of ["offers", "aggregateRating", "review", "price"])
        expect(node[key]).toBeUndefined();
  });

  it("escapes < so no string can break out of the script", () => {
    const text = jsonLdText({ name: "</script><script>alert(1)</script>" });
    expect(text).not.toContain("</script>");
    expect(text).not.toContain("<");
    expect(JSON.parse(text).name).toBe("</script><script>alert(1)</script>");
  });
});
