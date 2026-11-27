import { Keys, Trend, Usage } from "@/sikstack/frame";
import { SendFeedback } from "@/sikstack/send-feedback";
import { Grid, Stack } from "@/sikstack/ui";
import { ORG_HOME } from "@/content/dashboard";
import { requireIdentity } from "@/lib/auth-guards";
import { feedbackControl } from "@/lib/send-feedback/config";

import { mintOrgKey, revokeOrgKey } from "./actions";
import "./org-home.css";
import { ActivityLoading, ProjectsLoading } from "./org-home-loading";
import { ORG_KEYS_HEAD_ID } from "./org-home-model";

/** The moment the skeleton's trend axis is drawn for. */
function loadingNow(): number {
  return Date.now();
}

/**
 * Org home's Loading (`OrgHome.dc.html` Loading, frame.md F31): the Shell and the `h1` are complete
 * (the session knows the org; `requireIdentity` is the layout's cached read); the four figures are bars
 * under both headings; Projects, Trend and Recent activity draw their own skeletons; the
 * keys panel is `Keys`' own (F21). The same structure and sizes as the page, so nothing moves when the
 * data lands but the rows a table gains or loses after its third. The head's feedback control shows
 * while the page loads too (job 08's `## Build` §5), from the same cached identity, where the server
 * holds the control's key.
 */
export default async function DashboardLoading() {
  const { identity } = await requireIdentity();
  const orgName = identity.tenant?.name ?? "";
  const feedback = feedbackControl();
  const now = loadingNow();
  const lastDay = new Date(now).toISOString().slice(0, 10);

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
      <Usage loading busyLabel={ORG_HOME.loading} />
      <ProjectsLoading />
      <Grid className="orghome-pair">
        <Stack gap={5}>
          <Trend series={[]} lastDay={lastDay} loading format={{ now }} />
        </Stack>
        <ActivityLoading />
      </Grid>
      <Keys
        loading
        scope="org"
        subject={orgName}
        rows={[]}
        mint={mintOrgKey}
        revoke={revokeOrgKey}
        headId={ORG_KEYS_HEAD_ID}
      />
    </div>
  );
}
