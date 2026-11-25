import { ORG_HOME } from "@/content/dashboard";
import { Button, Panel, PanelBody, PanelHead, Skeleton } from "@/sikstack/ui";

/**
 * Org home's own skeletons (`OrgHomeProjects.dc.html`, `OrgHomeUrl.dc.html`,
 * `OrgHomeActivity.dc.html` Loading; frame.md F31): each bar sits in the real cell, so nothing moves
 * when the data lands. Shared by the route's `loading.tsx` and the Projects panel's Try again.
 */

const P = ORG_HOME.projects;

/*
 * The projects table's declared columns (FG9) are `.orghome-projects` (`org-home.css`), the same in the loaded
 * table and its skeleton: a class, not a style, so the loaded table drops them when it stacks (P78, F14).
 */

export function ProjectsTableHead() {
  return (
    <thead>
      <tr>
        <th scope="col" style={{ width: "35%" }}>
          {P.columns.project}
        </th>
        <th scope="col" className="num" style={{ width: "13%" }}>
          {P.columns.documents}
        </th>
        <th scope="col" className="num" style={{ width: "9%" }}>
          {P.columns.keys}
        </th>
        <th scope="col" style={{ width: "13%" }}>
          {P.columns.visibility}
        </th>
        <th scope="col" style={{ width: "15%" }}>
          {P.columns.created}
        </th>
        <th scope="col" style={{ width: "15%" }}>
          {P.columns.lastUsed}
        </th>
      </tr>
    </thead>
  );
}

/** Name, Created, Last used bar widths of the three rows, as the board draws them. */
const PROJECT_ROWS = [
  ["8em", "4em", "4em"],
  ["5em", "6em", "4em"],
  ["11em", "4em", "4em"],
] as const;

/** The table's three skeleton rows and the visually hidden `Loading…`. */
export function ProjectsTableLoading() {
  return (
    <>
      <div className="table-scroll">
        <table className="orghome-projects table">
          <ProjectsTableHead />
          <tbody>
            {PROJECT_ROWS.map(([name, created, used], i) => (
              <tr key={i}>
                <td>
                  <Skeleton width={name} />
                </td>
                <td className="num">
                  <Skeleton width="2em" />
                </td>
                <td className="num">
                  <Skeleton width="1em" />
                </td>
                <td>
                  <span
                    className="badge"
                    style={{ padding: 0, borderColor: "transparent" }}
                  >
                    {"​"}
                    <Skeleton width="4em" />
                  </span>
                </td>
                <td className="nowrap">
                  <Skeleton width={created} />
                </td>
                <td className="nowrap">
                  <Skeleton width={used} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <span className="sr-only">{ORG_HOME.loading}</span>
    </>
  );
}

/** The Projects head while the list loads: it keeps its size, the count a bar, New project disabled. */
export function ProjectsHeadLoading() {
  return (
    <PanelHead>
      <h2 style={{ flex: "1 0 auto" }}>{P.heading}</h2>
      <p className="meta">
        <Skeleton width="5em" />
      </p>
      <Button disabled aria-expanded={false}>
        {P.newProject}
      </Button>
    </PanelHead>
  );
}

export function ProjectsLoading() {
  return (
    <Panel aria-label={P.heading} aria-busy="true">
      <ProjectsHeadLoading />
      <ProjectsTableLoading />
    </Panel>
  );
}

export function UrlLoading() {
  return (
    <Panel aria-label={ORG_HOME.url.heading} aria-busy="true">
      <PanelHead>
        <h2>{ORG_HOME.url.heading}</h2>
      </PanelHead>
      <PanelBody rule>
        <div className="copy-field">
          <span className="copy-value">
            <Skeleton width="10em" />
          </span>
        </div>
        <span className="sr-only">{ORG_HOME.loading}</span>
      </PanelBody>
    </Panel>
  );
}

const ACTIVITY_ROWS = ["14em", "11em", "16em", "12em"] as const;

export function ActivityLoading() {
  return (
    <Panel aria-label={ORG_HOME.activity.heading} aria-busy="true">
      <PanelHead>
        <h2>{ORG_HOME.activity.heading}</h2>
      </PanelHead>
      <ul>
        {ACTIVITY_ROWS.map((w) => (
          <li key={w} className="row" style={ACTIVITY_ROW_STYLE}>
            <span>
              <Skeleton width={w} />
            </span>
            <span>
              <Skeleton width="3em" />
            </span>
          </li>
        ))}
      </ul>
      <span className="sr-only">{ORG_HOME.loading}</span>
    </Panel>
  );
}

/** An activity row: the sentence, then the time at the row's end. */
export const ACTIVITY_ROW_STYLE = {
  gridTemplateColumns: "minmax(0, 1fr) auto",
} as const;
