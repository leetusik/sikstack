"use client";

import Link from "next/link";
import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";

import { SKIP_TO_CONTENT } from "@/content";
import { PROJECT_HOME } from "@/content/project";
import { ShellOrgNameProvider, ToastRegion } from "@/sikstack/shell";
import { StateBlock } from "@/sikstack/states";
import { Block, BlockText, BlockTitle, buttonClass } from "@/sikstack/ui";
import { Legacy } from "@/sikstack/ui/boundary";
import { UiRoot } from "@/sikstack/ui/root";
import {
  AgendaFailed,
  AgendaList,
  AgendaLoading,
  deferredPageFrom,
  workspaceHrefs,
} from "@/sikstack/workspace/agenda";
import {
  AgendaItemLoading,
  AgendaItemPage,
  itemLines,
} from "@/sikstack/workspace/agenda-item";
import { itemProse } from "@/sikstack/workspace/agenda-item/prose";
import { WsItemFailed, WsNav, wsSyncLine, type WsSyncLine } from "@/sikstack/workspace/frame";
import { agendaHref, decodeWorkspaceFrom } from "@/lib/workspace/address";
import { itemState } from "@/lib/workspace/model";
import type { AgendaItem, WorkspaceHead } from "@/lib/workspace/types";
import AgendaError from "@/app/(app)/projects/[projectId]/workspace/error";
import AgendaItemRouteError from "@/app/(app)/projects/[projectId]/workspace/agenda/[item]/error";
import AgendaItemRouteLoading from "@/app/(app)/projects/[projectId]/workspace/agenda/[item]/loading";
import { agendaItemBack } from "@/app/(app)/projects/[projectId]/workspace/agenda/[item]/back";

import { Shell } from "@/sikstack/shell/shell";

import { DATA_SETS, HEADS, ME, WAITING_NOTE, type DataName } from "./answers";
import { DESIGN_MARK } from "./mark";
import { NOW, PROJECT, RECORDING, TIME_ZONE } from "./recording";
import { AGENDA_STATES, ITEM_STATES } from "./page-states";
import { StatePage } from "./states";
import {
  dataOf,
  getServerSnapshot,
  getSnapshot,
  load,
  reset,
  setItem,
  subscribe,
} from "./store";

/**
 * The design's screens: production's own components (`@/sikstack/...`) inside the Shell as
 * `AppShell` draws it (with the project rail's Design entry, P77), on the browser store's workspace. The clock is the recording's (`NOW`) and
 * the zone is the recording's, so the build and the browser draw the same text (no hydration
 * mismatch). What production does not have is the state widget (`states.tsx`), which holds Reset: each
 * page lists the states production's own branches draw for it, and draws each with production's parts.
 */

export function useSnap() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function useWorkspace() {
  return useSnap().workspace;
}

const never = () => () => {};
/** False on the build and while hydrating, true after: what only the browser knows waits for it. */
function useHydrated() {
  return useSyncExternalStore(never, () => true, () => false);
}

export const SHELL = RECORDING.shell;

export function Frame({ children }: { children: ReactNode }) {
  const ws = useWorkspace();
  return (
    <UiRoot data-design={DESIGN_MARK}>
      <Legacy>
        <a className="kb-skip" href={SKIP_TO_CONTENT.href}>
          {SKIP_TO_CONTENT.label}
        </a>
      </Legacy>
      <div className="page">
        <div className="app">
          <div className="app-frame">
            <Shell
              org={SHELL.org}
              orgs={[{ ...SHELL.org, address: null, projects: 1 }]}
              projects={[{ id: ws.project, ...SHELL.project }]}
              email={SHELL.email}
              due={0}
              orgRoute="/org"
            />
            <main id="main-content" className="app-main">
              <ShellOrgNameProvider name={SHELL.org.name}>{children}</ShellOrgNameProvider>
              <ToastRegion />
            </main>
          </div>
        </div>
      </div>
    </UiRoot>
  );
}

/** The line a failed read or a loading page draws (`page.tsx` NO_LINE, `loading.tsx` LOADING_LINE). */
const BLANK_LINE: WsSyncLine = { state: "fresh", text: "", cls: "", version: "" };

/** What a boundary state receives: a render that threw, as Next hands it (no digest: no server drew it). */
export const THROWN: Error & { digest?: string } = new Error("design: a render that threw");

function lineOf(ws: WorkspaceHead) {
  return wsSyncLine(ws.sync, ws.version, { timeZone: TIME_ZONE, now: NOW });
}

/**
 * Project home's Not found (`projects/[projectId]/not-found.tsx`, which `workspace/not-found.tsx` re-exports):
 * the same parts and words. Production's file is a server component that reads the session for the org's
 * name, which a static page has not, so it is drawn here from the Shell's org.
 */
function ProjectNotFound() {
  const org = SHELL.org.name;
  const w = PROJECT_HOME.notFound;
  return (
    <div className="column">
      <Block page>
        <BlockTitle>{w.title}</BlockTitle>
        <BlockText>{w.text(org)}</BlockText>
        <Link href="/dashboard" className={buttonClass()}>
          {w.back(org)}
        </Link>
      </Block>
    </div>
  );
}

export type AgendaState = (typeof AGENDA_STATES.list)[number]["key"];

export function AgendaScreen({
  state = "recorded",
  deferred,
  retry = () => {},
}: {
  state?: AgendaState;
  deferred?: string;
  retry?: () => void;
}) {
  const ws = useWorkspace();
  const read = useMemo(() => ({ agenda: ws.agenda, unplaced: ws.unplaced }), [ws]);
  const phases = useMemo(
    () => ws.phases.map((p) => ({ id: p.id, short: p.short, status: p.status })),
    [ws],
  );
  const hrefs = workspaceHrefs(ws.project);
  let body: ReactNode;
  switch (state) {
    case "loading":
      body = (
        <div className="column">
          <WsNav current="agenda" line={BLANK_LINE} hrefs={hrefs} loading />
          <AgendaLoading headId="agenda-loading-open" />
        </div>
      );
      break;
    case "unlinked":
    case "never": {
      const head = HEADS[state];
      body = (
        <div className="column">
          <WsNav
            current="agenda"
            line={lineOf(head)}
            hrefs={hrefs}
            command={
              typeof window === "undefined"
                ? null
                : PROJECT_HOME.workspace.run.command(window.location.origin, ws.project)
            }
          />
        </div>
      );
      break;
    }
    case "failed":
      body = (
        <div className="column">
          <WsNav current="agenda" line={BLANK_LINE} hrefs={hrefs} />
          <AgendaFailed />
        </div>
      );
      break;
    case "not-found":
      body = <ProjectNotFound />;
      break;
    case "error":
      body = <AgendaError error={THROWN} reset={retry} />;
      break;
    default:
      body = (
        <div className="column">
          <WsNav current="agenda" line={lineOf(ws)} hrefs={hrefs} />
          <AgendaList
            project={ws.project}
            read={read}
            phases={phases}
            timeZone={TIME_ZONE}
            deferredPage={deferredPageFrom(deferred)}
          />
        </div>
      );
  }
  return <Frame>{body}</Frame>;
}

export type ItemState = (typeof ITEM_STATES.list)[number]["key"];

export function ItemScreen({
  id,
  from,
  state,
  retry = () => {},
}: {
  id: string;
  from?: string | null;
  state?: ItemState;
  retry?: () => void;
}) {
  const ws = useWorkspace();
  const hydrated = useHydrated();
  const back = agendaItemBack(ws.project, from);
  const item = ws.agenda.find((a) => a.id === id);
  switch (state) {
    case "loading":
      return (
        <Frame>
          <AgendaItemRouteLoading />
        </Frame>
      );
    case "error":
      return (
        <Frame>
          <AgendaItemRouteError error={THROWN} reset={retry} />
        </Frame>
      );
    case "failed":
      return (
        <Frame>
          <WsItemFailed back={back} line={lineOf(ws)} />
        </Frame>
      );
    case "project-not-found":
      return (
        <Frame>
          <ProjectNotFound />
        </Frame>
      );
  }
  // An item this browser added has a page on the build too, but only the browser holds it.
  if (!item && !hydrated)
    return (
      <Frame>
        <AgendaItemLoading back={back} />
      </Frame>
    );
  const shown = state === "not-found" ? undefined : item;
  return (
    <Frame>
      <AgendaItemPage
        project={ws.project}
        back={back}
        from={decodeWorkspaceFrom(from, ws.project)}
        line={lineOf(ws)}
        timeZone={TIME_ZONE}
        now={NOW}
        prose={shown ? itemProse(shown) : undefined}
        read={
          shown
            ? { state: "ready", item: shown, ...itemLines(shown, ws) }
            : { state: "not-found", projectName: SHELL.project.name }
        }
      />
    </Frame>
  );
}

/** A recorded ended item's own words, for an item put in that state that has none of its own. */
function endedWords(state: "solved" | "dropped"): string {
  const it = RECORDING.workspace.agenda.find((a) => a.state === state);
  const own = it ? RECORDING.items[it.id] : undefined;
  return (state === "solved" ? own?.outcome : own?.reason) ?? "";
}

/** The item state the store's item is in, when the widget lists it. */
function itemImplied(item: AgendaItem | undefined): ItemState | null {
  if (!item) return "not-found";
  if (item.sync === "waiting" && !(item.entries ?? []).some((e) => e.sync === "waiting")) return "waiting";
  if ((item.entries ?? []).some((e) => e.sync === "waiting")) return "note-waiting";
  if (item.state === "proposed") return "proposed";
  const s = itemState(item);
  return s === "in_progress" ? null : s;
}

/** Made: who proposed a recorded Proposed item, for an item put in that state that has no proposal of its own. */
function recordedProposal(): AgendaItem["proposed"] {
  return RECORDING.workspace.agenda.find((a) => a.state === "proposed")?.proposed ?? null;
}

/** Put one item in a data state, unless it is in it already. */
function enterItem(id: string, key: ItemState) {
  const item = getSnapshot().workspace.agenda.find((a) => a.id === id);
  if (!item || itemImplied(item) === key) return;
  if (key === "waiting") return setItem(id, { sync: "waiting", entries: (item.entries ?? []).filter((e) => e.sync === null) });
  if (key === "proposed")
    return setItem(id, {
      state: "proposed",
      proposed: item.proposed ?? recordedProposal(),
      sync: null,
      entries: (item.entries ?? []).filter((e) => e.sync === null),
    });
  if (key === "note-waiting") {
    // made: the note `web-waiting` recorded waiting on A3-1z, by the design's account, last on this item's thread
    const at = ME.indexOf(":");
    return setItem(id, {
      sync: "waiting",
      entries: [
        ...(item.entries ?? []).filter((e) => e.sync === null),
        {
          id: "5f0c2e7a-8d41-4c3b-9a6e-2b7d1f4c8e90",
          kind: "note",
          author: ME,
          by: "person",
          name: ME.slice(at + 1),
          source: "web:agenda",
          created: RECORDING.now,
          body: WAITING_NOTE,
          job: null,
          sync: "waiting",
        },
      ],
    });
  }
  if (key !== "open" && key !== "deferred" && key !== "solved" && key !== "dropped") return;
  const fields: Partial<AgendaItem> = {
    state: key,
    sync: null,
    entries: (item.entries ?? []).filter((e) => e.sync === null),
  };
  if (key === "solved") fields.outcome = item.outcome || endedWords("solved");
  if (key === "dropped") fields.reason = item.reason || endedWords("dropped");
  setItem(id, fields);
}

/** Hold a data set, unless the store holds it already. */
function enterAgenda(key: AgendaState) {
  if (key in DATA_SETS && dataOf(getSnapshot()) !== key) load(key as DataName);
}

/** A page the design links to but does not draw. */
export function AwayScreen({ path }: { path: string }) {
  // The Design viewer's links open a build on its own host (`/api/design/open`), which a static build has not.
  const open = path === "/api/design/open";
  return (
    <Frame>
      <div className="column">
        <StateBlock
          state={{
            title: "Not in this design",
            text: open
              ? "In sikstack this opens the build on its own host, which this design build does not have."
              : `${path} is not part of this design build. It draws the Workspace's Agenda and its items, a piece of feedback, and Design.`,
            actions: [
              open
                ? { kind: "link", label: "Open Design", href: `/projects/${PROJECT}/design`, variant: "primary" }
                : { kind: "link", label: "Open the Agenda", href: agendaHref(PROJECT), variant: "primary" },
            ],
            reference: null,
          }}
        />
      </div>
    </Frame>
  );
}

/** The Agenda at its address, in the state `?state=` names; `?deferred=N` read in the browser. */
export function AgendaRoute() {
  const data = dataOf(useSnap());
  return (
    <StatePage states={AGENDA_STATES} implied={data} enter={enterAgenda} reset={reset}>
      {(state, pick, query) => (
        <AgendaScreen
          state={state}
          deferred={query?.get("deferred") ?? undefined}
          retry={() => pick(data)}
        />
      )}
    </StatePage>
  );
}

/** An item at its address, in the state `?state=` names; `?from=` read in the browser. */
export function ItemRoute({ id }: { id: string }) {
  const ws = useWorkspace();
  const implied = itemImplied(ws.agenda.find((a) => a.id === id));
  const enter = useCallback((key: ItemState) => enterItem(id, key), [id]);
  return (
    <StatePage states={ITEM_STATES} implied={implied} enter={enter} reset={reset}>
      {(state, pick, query) => (
        <ItemScreen
          id={id}
          from={query?.get("from") ?? null}
          state={state}
          retry={() => pick(implied ?? "open")}
        />
      )}
    </StatePage>
  );
}
