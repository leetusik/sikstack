"use client";

import { Suspense, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";

import { SKIP_TO_CONTENT } from "@/content";
import { Shell, ShellOrgNameProvider, ToastRegion } from "@/sikstack/shell";
import { StateBlock } from "@/sikstack/states";
import { Legacy } from "@/sikstack/ui/boundary";
import { UiRoot } from "@/sikstack/ui/root";
import {
  AgendaList,
  deferredPageFrom,
  workspaceHrefs,
} from "@/sikstack/workspace/agenda";
import { AgendaItemLoading, AgendaItemPage } from "@/sikstack/workspace/agenda-item";
import { itemLines } from "@/sikstack/workspace/agenda-item/model";
import { itemProse } from "@/sikstack/workspace/agenda-item/prose";
import { WsNav, wsSyncLine } from "@/sikstack/workspace/frame";
import { agendaHref, decodeWorkspaceFrom } from "@/lib/workspace/address";
import { agendaItemBack } from "@/app/(app)/projects/[projectId]/workspace/agenda/[item]/back";

import { DESIGN_MARK } from "./mark";
import { NOW, PROJECT, RECORDING, TIME_ZONE } from "./recording";
import { getServerSnapshot, getSnapshot, reset, subscribe } from "./store";

/**
 * The design's screens: production's own components (`@/sikstack/...`) inside the Shell as
 * `AppShell` draws it, on the browser store's workspace. The clock is the recording's (`NOW`) and
 * the zone is the recording's, so the build and the browser draw the same text (no hydration
 * mismatch). The one thing production does not have is the Reset control.
 */

function useWorkspace() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot).workspace;
}

const never = () => () => {};
/** False on the build and while hydrating, true after: what only the browser knows waits for it. */
function useHydrated() {
  return useSyncExternalStore(never, () => true, () => false);
}

const SHELL = RECORDING.shell;

function Frame({ children }: { children: ReactNode }) {
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
      <button
        type="button"
        className="btn"
        data-design-reset=""
        onClick={reset}
        style={{ position: "fixed", right: 12, bottom: 12, zIndex: 50 }}
      >
        Reset design data
      </button>
    </UiRoot>
  );
}

export function AgendaScreen({ deferred }: { deferred?: string }) {
  const ws = useWorkspace();
  const read = useMemo(() => ({ agenda: ws.agenda, unplaced: ws.unplaced }), [ws]);
  const phases = useMemo(
    () => ws.phases.map((p) => ({ id: p.id, short: p.short, status: p.status })),
    [ws],
  );
  return (
    <Frame>
      <div className="column">
        <WsNav
          current="agenda"
          line={wsSyncLine(ws.sync, ws.version, { timeZone: TIME_ZONE, now: NOW })}
          hrefs={workspaceHrefs(ws.project)}
        />
        <AgendaList
          project={ws.project}
          read={read}
          phases={phases}
          timeZone={TIME_ZONE}
          deferredPage={deferredPageFrom(deferred)}
        />
      </div>
    </Frame>
  );
}

export function ItemScreen({ id, from }: { id: string; from?: string | null }) {
  const ws = useWorkspace();
  const hydrated = useHydrated();
  const back = agendaItemBack(ws.project, from);
  const item = ws.agenda.find((a) => a.id === id);
  // An item this browser added has a page on the build too, but only the browser holds it.
  if (!item && !hydrated)
    return (
      <Frame>
        <AgendaItemLoading back={back} />
      </Frame>
    );
  return (
    <Frame>
      <AgendaItemPage
        project={ws.project}
        back={back}
        from={decodeWorkspaceFrom(from, ws.project)}
        line={wsSyncLine(ws.sync, ws.version, { timeZone: TIME_ZONE, now: NOW })}
        timeZone={TIME_ZONE}
        now={NOW}
        prose={item ? itemProse(item) : undefined}
        read={
          item
            ? { state: "ready", item, ...itemLines(item, ws) }
            : { state: "not-found", projectName: SHELL.project.name }
        }
      />
    </Frame>
  );
}

/** A page the design links to but does not draw. */
export function AwayScreen({ path }: { path: string }) {
  return (
    <Frame>
      <div className="column">
        <StateBlock
          state={{
            title: "Not in this design",
            text: `${path} is not part of this design build. It draws the Workspace's Agenda and its items.`,
            actions: [
              {
                kind: "link",
                label: "Open the Agenda",
                href: agendaHref(PROJECT),
                variant: "primary",
              },
            ],
            reference: null,
          }}
        />
      </div>
    </Frame>
  );
}

/** The Agenda at its address: `?deferred=N` read in the browser (a static page has no query). */
export function AgendaRoute() {
  return (
    <Suspense fallback={<AgendaScreen />}>
      <AgendaWithQuery />
    </Suspense>
  );
}

function AgendaWithQuery() {
  return <AgendaScreen deferred={useSearchParams().get("deferred") ?? undefined} />;
}

/** An item at its address: `?from=` read in the browser. */
export function ItemRoute({ id }: { id: string }) {
  return (
    <Suspense fallback={<ItemScreen id={id} />}>
      <ItemWithQuery id={id} />
    </Suspense>
  );
}

function ItemWithQuery({ id }: { id: string }) {
  return <ItemScreen id={id} from={useSearchParams().get("from")} />;
}
