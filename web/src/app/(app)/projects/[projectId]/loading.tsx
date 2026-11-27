import { cookies } from "next/headers";

import { Trend, Usage } from "@/sikstack/frame";
import { Grid } from "@/sikstack/ui";
import { requireIdentity } from "@/lib/auth-guards";

import { projectHomeFormat, todayIn } from "./model";
import { FeedbackPanel, LibraryPanel, WorkspacePanel } from "./parts";
import { ProjectHeadLoading } from "./project-head";

import "./project-home.css";

// Project home while it loads (`ProjectHome.dc.html`, Loading): every part keeps its head. The back
// link reads the org (the session read is per-request cached; the layout already made it); the `h1`
// holds a 7em skeleton; Workspace is its loading form (no count, three skeleton rows); Library and
// Feedback are their first load (no count: the Feedback board's loading form draws none); Usage and
// Trend load.
export default async function ProjectHomeLoading() {
  const { identity } = await requireIdentity();
  const org = identity.tenant?.name ?? "—";
  const format = projectHomeFormat(await cookies());
  return (
    <div className="column">
      <ProjectHeadLoading org={org} />
      <WorkspacePanel
        part={{ kind: "loading" }}
        origin={null}
        projectId={null}
      />
      <Grid min="26em">
        <LibraryPanel count={null} state={{ kind: "first-load" }} />
        <FeedbackPanel count={null} state={{ kind: "first-load" }} />
      </Grid>
      <div className="section">
        <Usage loading />
        <Trend series={[]} lastDay={todayIn(format)} loading format={format} />
      </div>
    </div>
  );
}
