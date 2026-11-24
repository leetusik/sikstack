import type { Metadata } from "next";
import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { cache } from "react";

import { WS_GLOSSARY, WS_PLACES } from "@/content/workspace/frame";
import { PHASE_PAGE } from "@/content/workspace/phase";
import { wsHeadOf, wsSyncLine, type WsBack } from "@/sikstack/workspace/frame";
import {
  agendaItemOf,
  PhaseFailed,
  PhaseMissing,
  PhaseView,
} from "@/sikstack/workspace/phase";
import { requireIdentity } from "@/lib/auth-guards";
import { getProject } from "@/lib/knowledge/app";
import { viewerTimeZone } from "@/lib/time-zone";
import {
  agendaItemHref,
  decodeWorkspaceFrom,
  FROM_PARAM,
  sliceHref,
  wayBack,
} from "@/lib/workspace/address";
import { dates } from "@/lib/workspace/model";
import { readPhase, readWorkspace } from "@/lib/workspace/read";
import { PHASE_ID } from "@/sikstack/workspace/phase";
import type { WorkspaceHead } from "@/lib/workspace/types";

/**
 * A phase (design job 02, `Phase.dc.html`; frame.md F48, F306): `/projects/<id>/workspace/phases/<phase>` in the
 * Shell. One read of the phase's own route (its record with the Workspace's sync facts beside it), and one read of
 * the Workspace only when the phase has an agenda item (its title, state and mark are the Agenda's, F47) or when
 * the phase is not found or failed (the back row keeps the sync line in every state, F84). The way back is the
 * backlog, at the page `?from=` names (F300). Not found also reads the project's name for its sentence (F49).
 * Dates are in the viewer's zone.
 */
type Params = { projectId: string; phaseId: string };
type Search = Record<string, string | string[] | undefined>;

/** The address's phase id, drawn in Loading's title only when it looks like one (never other text from the address). */
function phaseIdShown(raw: string): string | null {
  return PHASE_ID.test(raw) ? raw : null;
}

/** The phase's read, once a request: the tab title and the page share it. */
const loadPhase = cache(async (project: string, phase: string) => {
  const { token } = await requireIdentity();
  return readPhase(token, project, phase);
});

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { projectId, phaseId } = await params;
  try {
    const read = await loadPhase(projectId, phaseId);
    if (read.state === "ready")
      return {
        title: PHASE_PAGE.title(read.value.id, read.value.name),
        robots: { index: false },
      };
    if (read.state === "not-found")
      return { title: PHASE_PAGE.notFoundTitle, robots: { index: false } };
  } catch (error) {
    unstable_rethrow(error);
  }
  // the page renders the failure itself; the tab names the phase (`<id> · sikstack`)
  return { title: phaseIdShown(phaseId) ?? undefined, robots: { index: false } };
}

/** The project's name for Not found's sentence (F49); `—` when the project does not answer. */
async function projectName(token: string, project: string): Promise<string> {
  try {
    return (await getProject(token, project)).name || WS_GLOSSARY.none;
  } catch (error) {
    unstable_rethrow(error);
    return WS_GLOSSARY.none;
  }
}

/** The Workspace's sync facts when the phase's own read did not carry them; null when unknown. */
async function workspaceHead(
  token: string,
  project: string,
): Promise<WorkspaceHead | null> {
  return wsHeadOf(await readWorkspace(token, project));
}

export default async function PhasePage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { projectId, phaseId } = await params;
  const search = await searchParams;
  const { token } = await requireIdentity();
  const zone = viewerTimeZone(await cookies());
  const way = wayBack(
    projectId,
    { kind: "phase" },
    decodeWorkspaceFrom(search[FROM_PARAM], projectId),
  );
  const back: WsBack = { href: way.href, label: WS_PLACES.backlog };
  const read = await loadPhase(projectId, phaseId);

  if (read.state !== "ready") {
    const missing = read.state === "not-found";
    const [head, name] = await Promise.all([
      workspaceHead(token, projectId),
      missing ? projectName(token, projectId) : null,
    ]);
    const line = head
      ? wsSyncLine(head.sync, head.version, { timeZone: zone })
      : null;
    return missing ? (
      <PhaseMissing back={back} line={line} project={name ?? WS_GLOSSARY.none} />
    ) : (
      <PhaseFailed back={back} line={line} id={phaseIdShown(phaseId)} />
    );
  }

  const phase = read.value;
  let item = null;
  if (phase.agenda) {
    const ws = await readWorkspace(token, projectId);
    if (ws.state === "ready")
      item = agendaItemOf(phase.agenda, ws.value.agenda, ws.value.phases);
  }
  return (
    <PhaseView
      phase={phase}
      back={back}
      line={wsSyncLine(phase.workspace.sync, phase.workspace.version, {
        timeZone: zone,
      })}
      item={item}
      links={{
        slice: (full) => sliceHref(projectId, full, way.list),
        item: (id) => agendaItemHref(projectId, id),
      }}
      dates={dates(zone)}
    />
  );
}
