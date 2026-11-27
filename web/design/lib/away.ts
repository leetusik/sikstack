import { railFor } from "@/sikstack/shell/model";
import { workspaceHrefs } from "@/sikstack/workspace/agenda/model";

/**
 * The addresses the design's pages link to but do not draw (the Shell's rail and menus, the
 * Workspace's other tabs, the Design viewer's open route). Each gets a stub page, so a click lands on a page that says so and a
 * link's prefetch finds a file instead of a 404. Taken from production's own href helpers, so a
 * new link there shows up here; `design/scripts/build.mjs` fails on any link left without a page.
 */
export function awayPaths(project: string): string[] {
  const inDesign = new Set([
    `/projects/${encodeURIComponent(project)}/workspace`,
    `/projects/${encodeURIComponent(project)}/design`,
    // The org surfaces (P78-s2.S2's design) draw org home's address (the org switcher), Members and New org.
    "/dashboard",
    "/members",
    "/orgs/new",
    // The settings pages (P88-ms.S3's design); `/members` above moves the browser on to Org settings.
    "/settings",
    `/projects/${encodeURIComponent(project)}/settings`,
  ]);
  const ws = workspaceHrefs(project);
  const projectRail = railFor(`/projects/${encodeURIComponent(project)}/workspace`);
  const orgRail = railFor("/dashboard");
  const hrefs = [
    ws.backlog,
    ws.docs,
    ...projectRail.items.map((i) => i.href),
    projectRail.review.href,
    ...orgRail.items.map((i) => i.href),
    "/dashboard",
    // The Design viewer opens a build on its own host through this route (`src/sikstack/design/model.ts`).
    "/api/design/open",
    // The invite link's sign-in pair (P78-s2.S2's design).
    "/login",
    "/signup",
  ];
  const paths = new Set<string>();
  for (const href of hrefs) {
    if (!href) continue;
    const path = href.split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
    if (path !== "/" && !inDesign.has(path)) paths.add(path);
  }
  return [...paths].sort();
}

/** `generateStaticParams` for the catch-all stub route. */
export function awayParams(project: string): { away: string[] }[] {
  return awayPaths(project).map((p) => ({
    away: p.split("/").filter(Boolean).map(decodeURIComponent),
  }));
}
