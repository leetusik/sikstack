import { createElement, type ReactElement, Suspense } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Try again on every Workspace page that did not load (frame.md F40, F49): while it reads the page again the sync
// line is its bar, as while the page loads, then the line the new read gives. Every failed state is drawn here as
// its page or its route's boundary draws it, once at rest and once while a Try again reads (`markWsRetry`, which
// a Try again's `useWsRetry` holds for as long as its transition is pending). Node only: server renders, the
// reads mocked to fail.

const PROJECT = "3f9c2a10-6d4e-4b8a-9f1e-2c7d5b8a0e41";

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<object>()),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useParams: () => ({
    projectId: PROJECT,
    sliceId: "P57-4q.S4",
    phaseId: "P57-4q",
    item: "A7-m3",
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => `/projects/${PROJECT}/workspace`,
}));
const reads = vi.hoisted(() => ({
  readWorkspace: vi.fn(),
  readDoc: vi.fn(),
  readPhase: vi.fn(),
  readSlice: vi.fn(),
  readItem: vi.fn(),
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

const { markWsRetry, WsNav, WsSync, wsSyncLine } =
  await import("@/sikstack/workspace/frame");

const W = "@/app/(app)/projects/[projectId]/workspace";
const AgendaPage = (await import(`${W}/page`)).default;
const BacklogPage = (await import(`${W}/backlog/page`)).default;
const DocsPage = (await import(`${W}/docs/page`)).default;
const DocPage = (await import(`${W}/docs/[doc]/page`)).default;
const PhasePage = (await import(`${W}/phases/[phaseId]/page`)).default;
const SliceError = (await import(`${W}/slices/[sliceId]/error`)).default;
const ItemError = (await import(`${W}/agenda/[item]/error`)).default;
const PhaseError = (await import(`${W}/phases/[phaseId]/error`)).default;
const SlicePage = (await import(`${W}/slices/[sliceId]/page`)).default;
const ItemPage = (await import(`${W}/agenda/[item]/page`)).default;
const DocError = (await import(`${W}/docs/[doc]/error`)).default;

const html = (el: ReactElement) => renderToStaticMarkup(el);

/** A page that streams its body inside a keyed boundary (a doc, keyed on its version) is read as that body. */
async function settled(el: ReactElement): Promise<ReactElement> {
  if (el.type !== Suspense) return el;
  const inner = (el.props as { children: ReactElement<object> }).children;
  return (inner.type as (p: object) => Promise<ReactElement>)(inner.props);
}
const BAR =
  '<p class="sync" aria-busy="true"><span class="skel" style="width:9em"></span><span class="sr-only">Loading…</span></p>';

type Page = (props: {
  params: Promise<Record<string, string>>;
  searchParams: Promise<Record<string, string>>;
}) => Promise<ReactElement>;
const page = async (Component: Page, params: Record<string, string> = {}) =>
  html(
    await settled(
      await Component({
        params: Promise.resolve({ projectId: PROJECT, ...params }),
        searchParams: Promise.resolve({}),
      }),
    ),
  );
type Boundary = (props: {
  error: Error & { digest?: string };
  reset: () => void;
  retry: () => void;
}) => ReactElement;
const boundary = (Component: Boundary) =>
  html(
    createElement(Component, {
      error: Object.assign(new Error("did not load"), { digest: "4127790321" }),
      reset: () => {},
      retry: () => {},
    }),
  );

/** Each failed state, as drawn: its page with the reads failing, or its route's boundary. */
const FAILED: [name: string, draw: () => Promise<string> | string][] = [
  ["the Agenda", () => page(AgendaPage)],
  ["the backlog", () => page(BacklogPage)],
  ["the docs list", () => page(DocsPage)],
  ["a doc", () => page(DocPage, { doc: "architecture" })],
  ["a phase", () => page(PhasePage, { phaseId: "P57-4q" })],
  ["a slice", () => page(SlicePage, { sliceId: "P57-4q.S4" })],
  ["an agenda item", () => page(ItemPage, { item: "A7-m3" })],
  ["a phase's boundary", () => boundary(PhaseError)],
  ["a slice's boundary", () => boundary(SliceError)],
  ["an agenda item's boundary", () => boundary(ItemError)],
  ["a doc's boundary", () => boundary(DocError)],
];

let end: (() => void) | null = null;

beforeEach(() => {
  for (const read of Object.values(reads))
    read.mockResolvedValue({ state: "error", status: 503 });
});
afterEach(() => {
  end?.();
  end = null;
});

describe("the sync line while Try again reads the page again", () => {
  const fresh = wsSyncLine(
    { state: "fresh", at: "2026-11-18T08:58:00Z" },
    "v97",
    { timeZone: "Asia/Seoul", now: Date.parse("2026-11-18T09:00:00Z") },
  );

  it("is the bar while a Try again reads, then the line again", () => {
    expect(html(createElement(WsSync, { line: fresh }))).toContain(
      "Synced 2m ago",
    );
    end = markWsRetry();
    expect(html(createElement(WsSync, { line: fresh }))).toBe(BAR);
    const second = markWsRetry();
    end();
    // a second Try again still reading keeps the bar; ending one twice ends it once
    end();
    expect(html(createElement(WsSync, { line: fresh }))).toBe(BAR);
    second();
    end = null;
    expect(html(createElement(WsSync, { line: fresh }))).toContain(
      "Synced 2m ago",
    );
  });

  it("draws WsNav's loading form, the title and the places standing", () => {
    const hrefs = {
      agenda: "/a",
      backlog: "/b",
      docs: "/o",
    };
    end = markWsRetry();
    const out = html(
      createElement(WsNav, { current: "agenda", line: fresh, hrefs }),
    );
    const loading = html(
      createElement(WsNav, {
        current: "agenda",
        line: fresh,
        hrefs,
        loading: true,
      }),
    );
    expect(out).toBe(loading);
    expect(out).toContain(BAR);
  });

  it.each(FAILED)(
    "on %s: no bar at rest, the bar while Try again reads",
    async (_, draw) => {
      const rest = await draw();
      expect(rest).toContain("Try again");
      expect(rest).not.toContain(BAR);
      end = markWsRetry();
      const reading = await draw();
      expect(reading).toContain(BAR);
      expect(reading.split(BAR)).toHaveLength(2);
    },
  );
});
