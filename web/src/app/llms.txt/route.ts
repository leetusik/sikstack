import { llmsText } from "@/sikstack/seo/llms";

// P87 — `/llms.txt`, for answer engines: what sikstack is, the plugin's install commands and the key links
// (`@/sikstack/seo/llms`). The landing's words, baked at build like the rest of the site's metadata
// (`SITE.url` is `NEXT_PUBLIC_APP_URL`). `src/proxy.ts`'s matcher skips it, as it does `robots.txt`.
export const dynamic = "force-static";

export function GET(): Response {
  return new Response(llmsText(), {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
