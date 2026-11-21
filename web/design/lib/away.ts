import { railFor } from "@/sikstack/shell/model";
import { workspaceHrefs } from "@/sikstack/workspace/agenda/model";

/**
 * The addresses the design's pages link to but do not draw (the Shell's rail and menus, the
 * Workspace's other tabs). Each gets a stub page, so a click lands on a page that says so and a
 * link's prefetch finds a file instead of a 404. Taken from production's own href helpers, so a
 * new link there shows up here; `design/scripts/build.mjs` fails on any link left without a page.
 */
export function awayPaths(project: string): string[] {
  const inDesign = new Set([`/projects/${encodeURIComponent(project)}/workspace`]);
  const ws = workspaceHrefs(project);
  const projectRail = railFor(`/projects/${encodeURIComponent(project)}/workspace`);
  const orgRail = railFor("/dashboard");
  const hrefs = [
    ws.backlog,
    ws.deferred,
    ws.docs,
    ...projectRail.items.map((i) => i.href),
    projectRail.review.href,
    ...orgRail.items.map((i) => i.href),
    "/dashboard",
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
