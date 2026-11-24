import type { Metadata } from "next";
import { cookies } from "next/headers";

import { DASHBOARD } from "@/content/dashboard";
import { Keys, Trend, Usage } from "@/sikstack/frame";
import { SendFeedback } from "@/sikstack/send-feedback";
import { Grid, Stack } from "@/sikstack/ui";
import { requireIdentity } from "@/lib/auth-guards";
import { feedbackControl } from "@/lib/send-feedback/config";
import type { FormatOptions } from "@/lib/format";
import {
  getDashboard,
  getDocuments,
  getUsage,
  listOrgCredentials,
} from "@/lib/knowledge/app";
import { getMembers } from "@/lib/knowledge/orgs";
import type { KbDashboard } from "@/lib/knowledge/types";

import { ActivityPanel } from "./activity-panel";
import { HashLanding } from "./hash-landing";
import {
  createOrgProject,
  mintOrgKey,
  revokeOrgKey,
  saveOrgSlug,
} from "./actions";
import "./org-home.css";
import {
  activityLines,
  keyRow,
  ORG_KEYS_HEAD_ID,
  orgHomeFormat,
  projectRows,
} from "./org-home-model";
import { renameOrgAction } from "../orgs/actions";
import { NamePanel } from "./name-panel";
import { ProjectsPanel } from "./projects-panel";
import { UrlPanel } from "./url-panel";

/**
 * Org home (job 01 round 03-instrument, `OrgHome.dc.html`): a system page inside the Shell, in the
 * signed order: the org's name; the read-out in two groups; Projects; Trend with Public URL beside
 * Recent activity; Org API keys. The toast region is the Shell's (`publishToast`). For the org's owner,
 * Org name (F15's rename, P78) sits over Public URL, in its pattern; the role is `/app/members`'s.
 *
 * Reads, in parallel: `/app/usage` (the 30-day figures and the trend), `/app/credentials` (the org's
 * keys, and their lines in the feed), `/app/documents` (`total`: Active total, the documents the org
 * holds now), and the Projects panel's own: `/app/dashboard` (the rows, each with its Documents count,
 * and the project feed), one read whatever the number of projects. A failure of that read is the
 * panel's own state (Projects did not load.); any other failure is the route's error page. Dates are
 * in the viewer's zone (`kb_tz`), UTC until it is known.
 *
 * At the end of the page head, sikstack's own feedback control (job 08, round
 * 01-landing-diagram-feedback, `## Build` §5) as the signed-in user, `Sends as` the Shell's account,
 * only where the server holds the control's key; without it the head is the title alone.
 */
export const metadata: Metadata = { title: DASHBOARD.title };

/** The caller's role in the active org (`GET /app/members`); a fault is `null`, and the rename stays hidden. */
async function readRole(token: string): Promise<"owner" | "member" | null> {
  try {
    return (await getMembers(token)).role;
  } catch {
    return null;
  }
}

async function readProjects(token: string): Promise<KbDashboard | null> {
  try {
    return await getDashboard(token);
  } catch {
    return null;
  }
}

/** Today's calendar date in the zone the page formats in. */
function today(format: FormatOptions): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: format.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(format.now);
}

export default async function DashboardPage() {
  const { token, identity } = await requireIdentity();
  const orgName = identity.tenant?.name ?? "";
  const slug = identity.tenant?.slug ?? null;
  const format = orgHomeFormat(await cookies());
  const feedback = feedbackControl();

  const [usage, orgKeys, held, projects, role] = await Promise.all([
    getUsage(token),
    listOrgCredentials(token),
    getDocuments(token, { limit: 1 }),
    readProjects(token),
    readRole(token),
  ]);

  const series = usage.daily_counts.map((day) => day.searches);
  const lastDay = usage.daily_counts.at(-1)?.day ?? today(format);

  return (
    <div className="column">
      <header className="page-top">
        <div className="page-head">
          <div className="page-title">
            <h1>{orgName}</h1>
          </div>
          {feedback.configured ? (
            <SendFeedback
              context="account"
              limit={feedback.limit}
              account={identity.user.email}
              triggerClassName="btn"
            />
          ) : null}
        </div>
      </header>
      <Usage
        figures={{
          docs30: usage.totals.documents_created,
          searches30: usage.totals.searches,
          deleted30: usage.totals.documents_deleted,
          docs: held.total,
        }}
      />
      <ProjectsPanel
        rows={projects ? projectRows(projects.projects, format) : null}
        create={createOrgProject}
      />
      <Grid className="orghome-pair">
        <Stack gap={5}>
          <Trend series={series} lastDay={lastDay} format={format} />
          {role === "owner" ? <NamePanel name={orgName} save={renameOrgAction} /> : null}
          <UrlPanel slug={slug} save={saveOrgSlug} />
        </Stack>
        <ActivityPanel
          lines={activityLines(projects?.activity ?? [], orgKeys, format)}
        />
      </Grid>
      <Keys
        scope="org"
        subject={orgName}
        rows={orgKeys.map(keyRow)}
        mint={mintOrgKey}
        revoke={revokeOrgKey}
        format={format}
        headId={ORG_KEYS_HEAD_ID}
      />
      <HashLanding id={ORG_KEYS_HEAD_ID} />
    </div>
  );
}
