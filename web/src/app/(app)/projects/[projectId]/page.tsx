import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";

import { Trend, Usage } from "@/sikstack/frame";
import { Grid } from "@/sikstack/ui";
import { requireIdentity } from "@/lib/auth-guards";
import { countFeedback, listFeedbackPage } from "@/lib/feedback/app";
import { feedbackHref } from "@/lib/feedback/place";
import { date, type FormatOptions } from "@/lib/format";
import {
  getDocuments,
  getOrgLibrary,
  getProjectUsage,
} from "@/lib/knowledge/app";
import { ApiError } from "@/lib/knowledge/client";
import { getMembers } from "@/lib/knowledge/orgs";
import type { KbIdentity, KbProjectUsage } from "@/lib/knowledge/types";
import { orgSegment, projectLibraryHref } from "@/lib/reader-href";
import { readWorkspace } from "@/lib/workspace/read";

import { FeedbackFailed } from "./feedback-retry";
import { LibraryFailed } from "./library-retry";
import {
  FEEDBACK_SHOWN,
  feedbackCount,
  feedbackRows,
  isMissingProjectStatus,
  keyRowOf,
  libraryCount,
  libraryRows,
  monthWindow,
  projectHomeFormat,
  requestOrigin,
  todayIn,
  type FeedbackRow,
  workspacePart,
  type LibraryRow,
} from "./model";
import { FeedbackPanel, LibraryPanel, WorkspacePanel } from "./parts";
import { ProjectHead } from "./project-head";
import { ProjectKeys } from "./project-keys";

import "./project-home.css";

// Project home (job 01, round 03-instrument, `ProjectHome.dc.html`), a system page inside the Shell:
// `div.column` straight into `main.app-main`. In the signed order: the head, Workspace, Library and
// Feedback side by side, Usage in two groups with Trend, the project's API keys.
//
// Every figure comes from a read the page already had or the app already makes:
// - the head, Usage and Trend, and the keys: `getProjectUsage` (one read; 30-day window);
// - Active total (Usage) and the Library's count: `getDocuments({project, limit: 1}).total`;
// - the Library's rows: the org library listing (`getOrgLibrary`), this project's books and documents;
// - Feedback: page 1 of `listFeedbackPage({project_id, limit: 5, state: "all"})`, and `countFeedback` over the
//   viewer's month for `N this month` (D247-4x); either failing is the panel's failed form.
// - Workspace: the project's Workspace (`readWorkspace`, one read: its phases and agenda items); for a
//   project not linked or never synced, the link command from the request's origin (`headers()`).
// Every date is in the viewer's zone (the `kb_tz` cookie), UTC until it is known (decision 5).
//
// The <title> is the project's name (P78, F17), the folder's `layout.tsx`'s default: this page sets none.

/** The project read; a missing or another org's id renders Not found (404-never-403). */
async function loadProject(
  token: string,
  projectId: string,
): Promise<KbProjectUsage> {
  try {
    return await getProjectUsage(token, projectId);
  } catch (error) {
    if (error instanceof ApiError && isMissingProjectStatus(error.status)) {
      notFound();
    }
    throw error;
  }
}

/**
 * The Library's rows. A failure here is the panel's own failed form, never the page's; a 401 is the
 * session's and is rethrown (the guard sends it to sign-in).
 */
async function loadLibraryRows(
  token: string,
  identity: KbIdentity,
  projectName: string,
): Promise<LibraryRow[] | null> {
  const tenant = identity.tenant;
  if (!tenant) return [];
  try {
    const listing = await getOrgLibrary(token, orgSegment(tenant), "all");
    return libraryRows(listing, projectName);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) throw error;
    return null;
  }
}

/**
 * The Feedback panel's two reads: the five newest messages and the count over the viewer's month.
 * `rows` is `null` when either failed (the panel's own failed form, never the page's, D247-4x);
 * `count` is `null` when the count read failed. A 401 is the session's and is rethrown.
 */
async function loadFeedback(
  token: string,
  projectId: string,
  format: FormatOptions,
): Promise<{ rows: FeedbackRow[] | null; count: string | null }> {
  // Each read inside its own async function, so a throw before its first await is a rejection too.
  const [list, month] = await Promise.allSettled([
    (async () =>
      listFeedbackPage(
        token,
        // every state (P91-v3): without `state` the API lists Open alone
        { project_id: projectId, limit: FEEDBACK_SHOWN, state: "all" },
        1,
      ))(),
    (async () =>
      countFeedback(token, {
        project_id: projectId,
        ...monthWindow(format),
      }))(),
  ]);
  for (const read of [list, month]) {
    if (
      read.status === "rejected" &&
      read.reason instanceof ApiError &&
      read.reason.status === 401
    )
      throw read.reason;
  }
  const count =
    month.status === "fulfilled" ? feedbackCount(month.value) : null;
  if (list.status === "rejected" || month.status === "rejected")
    return { rows: null, count };
  return { rows: feedbackRows(list.value.records, projectId, format), count };
}

/** The viewer's role in the org (`GET /app/members`); `null` when the read fails (the head then draws no switch). */
async function readRole(token: string): Promise<"owner" | "member" | null> {
  try {
    return (await getMembers(token)).role;
  } catch {
    return null;
  }
}

export default async function ProjectHomePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const { token, identity } = await requireIdentity();
  const org = identity.tenant?.name ?? "—";
  const format = projectHomeFormat(await cookies());

  const usage = await loadProject(token, projectId);
  const { project } = usage;
  const [documents, rows, feedback, workspace, role] = await Promise.all([
    getDocuments(token, { project: project.id, limit: 1 }),
    loadLibraryRows(token, identity, project.name),
    loadFeedback(token, project.id, format),
    readWorkspace(token, project.id),
    readRole(token),
  ]);
  const count = libraryCount(documents.total);
  const origin = requestOrigin(await headers());
  const series = usage.daily_counts.map((d) => d.searches);
  const lastDay = usage.daily_counts.at(-1)?.day ?? todayIn(format);

  return (
    <div className="column">
      <ProjectHead
        projectId={project.id}
        name={project.name}
        org={org}
        created={date(project.created_at, format)}
        visibility={project.visibility}
        owner={role === "owner"}
      />
      <WorkspacePanel
        part={workspacePart(workspace, project.id)}
        origin={origin}
        projectId={project.id}
      />
      <Grid min="26em">
        {rows === null ? (
          <LibraryFailed count={count} />
        ) : (
          <LibraryPanel
            count={count}
            state={{
              kind: "rows",
              rows,
              all: projectLibraryHref(project.id),
            }}
            format={format}
          />
        )}
        {feedback.rows === null ? (
          <FeedbackFailed count={feedback.count} />
        ) : (
          <FeedbackPanel
            count={feedback.count}
            state={{
              kind: "rows",
              rows: feedback.rows,
              all: feedbackHref(project.id),
            }}
          />
        )}
      </Grid>
      <div className="section">
        <Usage
          figures={{
            docs30: usage.totals.documents_created,
            searches30: usage.totals.searches,
            deleted30: usage.totals.documents_deleted,
            docs: documents.total,
          }}
        />
        <Trend series={series} lastDay={lastDay} format={format} />
      </div>
      <ProjectKeys
        projectId={project.id}
        subject={project.name}
        rows={usage.credentials.map(keyRowOf)}
        format={format}
      />
    </div>
  );
}
