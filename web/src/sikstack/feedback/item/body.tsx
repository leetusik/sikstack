import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, unstable_rethrow } from "next/navigation";
import { cache, type ReactNode } from "react";

import { itemHeading, NOT_FOUND } from "@/content/feedback-frame";
import { requireIdentity } from "@/lib/auth-guards";
import { canAdd, sent } from "@/lib/feedback/agenda";
import { fileAgendaItem } from "@/lib/feedback/agenda-actions";
import { getFeedbackAgenda, getFeedbackDetail } from "@/lib/feedback/app";
import { zoneLabel } from "@/lib/feedback/format";
import { feedbackBackHref, type FeedbackScope } from "@/lib/feedback/place";
import type { FeedbackAgenda, FeedbackDetail } from "@/lib/feedback/types";
import { listProjects } from "@/lib/knowledge/app";
import { ApiError } from "@/lib/knowledge/client";
import { getMembers } from "@/lib/knowledge/orgs";
import type { KbProject } from "@/lib/knowledge/types";
import { TIME_ZONE_COOKIE, viewerTimeZone } from "@/lib/time-zone";
import { readWorkspace } from "@/lib/workspace/read";

import {
  AddedToAgenda,
  AgendaHeadEnd,
  AgendaPart,
  AgendaScope,
  AgendaSlot,
  agendaPageState,
  pickable,
  type PickItem,
} from "../agenda";
import { ItemStateActs, ItemStateLine } from "../state/control";
import { OPEN, type OrgRole } from "../state/model";
import { FeedbackItem } from "./item";
import { feedbackItemView, inScope, isFeedbackId, zoneMetaOf } from "./model";
import { ItemStateScope } from "./state";

/**
 * One piece of feedback's server body, shared by its two routes (P65-nh.S3's addresses):
 * `/feedback/[feedbackId]` (the org's, `scope` null) and `/projects/[projectId]/feedback/[feedbackId]`
 * (`scope` the project). Each route's `page.tsx` only reads its params and renders this.
 *
 * Feedback not found (`notFound()`, the route's `not-found.tsx`) for: an id that is no UUID (never
 * sent), a record the API does not return to this org (its 404; a 400 alike), and in a project's
 * route a record of another project or of none. Any other failure throws to the route's `error.tsx`.
 */

/** What the page read: the record and the org's projects (the record names its project by id only). */
export interface FeedbackItemRead {
  record: FeedbackDetail;
  projects: KbProject[];
  /** The record's project's name, or null for none. */
  projectName: string | null;
}

/**
 * The record at this address, or null for Feedback not found. One read per request (`cache`), so the
 * tab title and the page share it.
 */
export const readFeedbackItem = cache(
  async (
    scope: FeedbackScope,
    feedbackId: string,
  ): Promise<FeedbackItemRead | null> => {
    if (!isFeedbackId(feedbackId)) return null;
    const { token } = await requireIdentity();
    let record: FeedbackDetail;
    let projects: KbProject[];
    try {
      [record, projects] = await Promise.all([
        getFeedbackDetail(token, feedbackId),
        listProjects(token),
      ]);
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 404 || error.status === 400)
      )
        return null;
      throw error;
    }
    if (!inScope(record, scope)) return null;
    const projectName =
      (record.project_id &&
        projects.find((p) => p.id === record.project_id)?.name) ||
      null;
    return { record, projects, projectName };
  },
);

/** The tab title, through the site's template: `Feedback on platform`, `Feedback`, or Feedback not found. */
export async function feedbackItemMetadata(
  scope: FeedbackScope,
  feedbackId: string,
): Promise<Metadata> {
  try {
    const read = await readFeedbackItem(scope, feedbackId);
    return {
      title: read ? itemHeading(read.projectName) : NOT_FOUND.item,
      robots: { index: false },
    };
  } catch (error) {
    unstable_rethrow(error);
    // the page renders the failure itself
    return { robots: { index: false } };
  }
}

/**
 * What the record became on its project's agenda (`GET /app/feedback/{id}/agenda`), or null for a record in no
 * project. A failed read is the whole page's error (`error.tsx`), as the record's own read is.
 */
async function readAgenda(
  record: FeedbackDetail,
): Promise<FeedbackAgenda | null> {
  if (!record.project_id) return null;
  const { token } = await requireIdentity();
  return getFeedbackAgenda(token, record.id);
}

/**
 * The items the confirm offers beside a new one: the project's agenda (`GET …/workspace`), every item not ended,
 * in the Agenda's order (`pickable`). A failed read offers a new item alone.
 */
async function pickableItems(record: FeedbackDetail): Promise<PickItem[]> {
  if (!record.project_id) return [];
  const { token } = await requireIdentity();
  const ws = await readWorkspace(token, record.project_id);
  return ws.state === "ready" ? pickable(ws.value.agenda, []) : [];
}

/**
 * The caller's role in the active org (`GET /app/members`), read as the list reads it: an owner deletes; a member, or
 * a role read that failed, sees no Delete (the API refuses a member's delete either way).
 */
async function readRole(token: string): Promise<OrgRole> {
  try {
    return (await getMembers(token)).role === "owner" ? "owner" : "member";
  } catch (error) {
    unstable_rethrow(error);
    return "member";
  }
}

/** The head's end (P91-v3): the state's actions, then what Add to agenda put there. */
function HeadEnd({ children }: { children?: ReactNode }) {
  return (
    <div className="cluster fi-head-end">
      <ItemStateActs />
      {children}
    </div>
  );
}

export async function FeedbackItemBody({
  scope,
  feedbackId,
  from,
}: {
  scope: FeedbackScope;
  feedbackId: string;
  /** The item address's `?from=`: the list it was opened from (laundered by `feedbackBackHref`). */
  from: string | string[] | undefined;
}) {
  const read = await readFeedbackItem(scope, feedbackId);
  if (!read) notFound();
  const store = await cookies();
  const { token } = await requireIdentity();
  const role = await readRole(token);
  const timeZone = viewerTimeZone(store);
  const view = feedbackItemView(read.record, {
    projectName: read.projectName,
    zone: zoneMetaOf(store.get(TIME_ZONE_COOKIE)?.value, (tz) => zoneLabel(tz)),
    format: { timeZone },
  });
  const backHref = feedbackBackHref(scope, from);
  // The state (P91-v3): its line under the title and its actions at the head's end, before Add to agenda, in one
  // island over the list's two server actions; Delete goes back to `backHref` with the toast.
  const stated = (page: ReactNode) => (
    <ItemStateScope
      id={read.record.id}
      message={read.record.message}
      lang={view.lang}
      initial={read.record.state ?? OPEN}
      role={role}
      counted={{
        comments: read.record.comments.length,
        files: read.record.attachments.length,
      }}
      timeZone={timeZone}
      backHref={backHref}
    >
      {page}
    </ItemStateScope>
  );
  // The two slots (P65-nh.S6, P61-e9): Add to agenda at the head's end and the Agenda part, from the
  // agenda seam over `GET /app/feedback/{id}/agenda`, in the board's order: filed, else waiting, else
  // not offered, else the add. Once the record is on an item the head reads Added to agenda and offers
  // no second add (as drawn).
  const filed = await readAgenda(read.record);
  const agenda = agendaPageState(
    canAdd(read.record, read.projectName, filed),
    sent(read.record, filed),
  );
  if (agenda.kind === "offered") {
    const items = await pickableItems(read.record);
    return stated(
      <AgendaScope
        project={agenda.project}
        items={items}
        add={fileAgendaItem.bind(null, read.record.id)}
      >
        <FeedbackItem
          view={view}
          backHref={backHref}
          state={<ItemStateLine />}
          headEnd={
            <HeadEnd>
              <AgendaHeadEnd />
            </HeadEnd>
          }
          agenda={<AgendaSlot />}
        />
      </AgendaScope>,
    );
  }
  return stated(
    <FeedbackItem
      view={view}
      backHref={backHref}
      state={<ItemStateLine />}
      headEnd={
        <HeadEnd>
          {agenda.kind === "not-offered" ? null : <AddedToAgenda />}
        </HeadEnd>
      }
      agenda={<AgendaPart state={agenda} />}
    />,
  );
}
