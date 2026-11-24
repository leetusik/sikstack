import { createElement, type ReactElement, Suspense } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// One failed state for every item page (frame.md F49, F84; F5's app error): a phase, a slice, an agenda item and
// a doc that did not load all draw the back row with the sync line (the workspace answered, the
// item's own read did not), F5's block with Try again and the item's way back, the reference when the error has a
// digest (the route's boundary), and the item's id as the tab's title (`<id> · sikstack`). Node only: server
// renders, the item's read mocked to fail and the Workspace's to answer.

const PROJECT = "3f9c2a10-6d4e-4b8a-9f1e-2c7d5b8a0e41";
const IDS = {
  phaseId: "P57-4q",
  sliceId: "P57-4q.S4",
  item: "A7-m3",
  doc: "architecture",
};

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<object>()),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useParams: () => ({ projectId: PROJECT, ...IDS }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => `/projects/${PROJECT}/workspace`,
}));
const reads = vi.hoisted(() => ({
  readWorkspace: vi.fn(),
  readPhase: vi.fn(),
  readSlice: vi.fn(),
  readItem: vi.fn(),
  readDoc: vi.fn(),
}));
vi.mock("@/lib/workspace/read", async (orig) => ({
  ...(await orig<object>()),
  ...reads,
}));
vi.mock("@/lib/knowledge/app", () => ({
  getProject: vi.fn(async () => ({ name: "platform" })),
  listProjects: vi.fn(async () => [{ id: PROJECT, name: "platform" }]),
}));
vi.mock("@/lib/auth-guards", () => ({
  requireIdentity: vi.fn(async () => ({
    token: "t",
    identity: {
      tenant: { id: "t1", slug: "june", name: "June's notes" },
      tenants: [],
    },
  })),
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === "kb_tz" ? { value: "Asia/Seoul" } : undefined,
  })),
  headers: vi.fn(async () => new Headers({ host: "p67.localhost:8080" })),
}));

const W = "@/app/(app)/projects/[projectId]/workspace";
type Route = {
  default: (props: {
    params: Promise<Record<string, string>>;
    searchParams: Promise<Record<string, string>>;
  }) => Promise<ReactElement>;
  generateMetadata?: (props: {
    params: Promise<Record<string, string>>;
    searchParams: Promise<Record<string, string>>;
  }) => Promise<{ title?: unknown }>;
  metadata?: { title?: unknown };
};
type Boundary = {
  default: (props: {
    error: Error & { digest?: string };
    reset: () => void;
    retry: () => void;
  }) => ReactElement;
};

/** Each item page: its route folder, the id the tab names, the way back its block offers. */
const PAGES: [name: string, dir: string, id: string, back: string][] = [
  ["a phase", "phases/[phaseId]", IDS.phaseId, "Back to Backlog"],
  ["a slice", "slices/[sliceId]", IDS.sliceId, "Back to P57-4q"],
  ["an agenda item", "agenda/[item]", IDS.item, "Back to Agenda"],
  ["a doc", "docs/[doc]", IDS.doc, "Back to Docs"],
];

const props = () => ({
  params: Promise.resolve({ projectId: PROJECT, ...IDS }),
  searchParams: Promise.resolve({}),
});
const html = (el: ReactElement) => renderToStaticMarkup(el);

/** A page that streams its body inside a keyed boundary (a doc, keyed on its version) is read as that body. */
async function settled(el: ReactElement): Promise<ReactElement> {
  if (el.type !== Suspense) return el;
  const inner = (el.props as { children: ReactElement<object> }).children;
  return (inner.type as (p: object) => Promise<ReactElement>)(inner.props);
}

/** The sync line as the back row draws it when the workspace answered (not its bar, not an empty line). */
const LINE =
  /<p class="sync[^"]*"><span class="status[^"]*">Synced [^<]+<\/span><span><span class="sr-only">[^<]*<\/span>v97<\/span><\/p>/;

beforeEach(() => {
  reads.readWorkspace.mockResolvedValue({
    state: "ready",
    value: {
      version: "v97",
      sync: {
        state: "fresh",
        at: new Date(Date.now() - 120_000).toISOString(),
      },
      phases: [],
      agenda: [],
      docs: [],
    },
  });
  for (const read of [
    reads.readPhase,
    reads.readSlice,
    reads.readItem,
    reads.readDoc,
  ])
    read.mockResolvedValue({ state: "error", status: 503 });
});

describe("an item page whose read failed", () => {
  it.each(PAGES)(
    "on %s: the back row with the sync line, F5's block, no reference without a digest",
    async (_, dir, __, back) => {
      const route = (await import(`${W}/${dir}/page`)) as Route;
      const out = html(await settled(await route.default(props())));
      expect(out).toMatch(LINE);
      expect(out).toContain("This page did not load");
      expect(out).toContain(">Try again</button>");
      expect(out).toContain(`>${back}</a>`);
      expect(out).not.toContain("Reference");
      // the back row comes first, then the block
      expect(out.indexOf('class="sync')).toBeLessThan(
        out.indexOf("This page did not load"),
      );
    },
  );

  it.each(PAGES)("on %s: the tab names the item's id", async (_, dir, id) => {
    const route = (await import(`${W}/${dir}/page`)) as Route;
    expect(route.generateMetadata).toBeTypeOf("function");
    const meta = await route.generateMetadata!(props());
    expect(meta.title).toBe(id);
  });
});

describe("an item page whose render threw (its route's boundary)", () => {
  it.each(PAGES)(
    "on %s: the back row, F5's block and the reference from the digest",
    async (_, dir, __, back) => {
      const boundary = (await import(`${W}/${dir}/error`)) as Boundary;
      const out = html(
        createElement(boundary.default, {
          error: Object.assign(new Error("did not load"), {
            digest: "4127790321",
          }),
          reset: () => {},
          retry: () => {},
        }),
      );
      expect(out).toContain('<div class="ws-top"><a class="back"');
      expect(out).toContain("This page did not load");
      expect(out).toContain(">Try again</button>");
      expect(out).toContain(`>${back}</a>`);
      expect(out).toContain('<p class="meta">Reference 4127790321</p>');
    },
  );
});
