"use client";

import Image from "next/image";
import { useState } from "react";

import { DesignListView } from "../next/design/list";
import { DesignBuildGone, DesignBuildView } from "../next/design/viewer";

import {
  DESIGN_LISTS,
  DESIGN_PART,
  DIRECTION_SHOTS,
  detailFor,
  kindOf,
  madeShareUrl,
  type BuildKind,
  type DesignDetail,
} from "./design-data";
import { NOW, PROJECT, RECORDING, TIME_ZONE } from "./recording";
import { Frame } from "./screens";
import { pageStates, StatePage } from "./states";

/**
 * The Design service's screens (P77): the list and a build's viewer, drawn by their next components
 * (`next/design/`) inside the Shell, on the recorded answers (`design-data.ts`). Production does not draw them
 * yet, so each state's `from` names the next component's branch and the answer it draws.
 */

const LIST = "next/design/list.tsx";
const VIEW = "next/design/viewer.tsx";

/** The Design list's states: the recorded list at each step of the publishes (`design-data.ts`). */
export const DESIGN_LIST_STATES = pageStates("Design", [
  { key: "many", label: "Many builds", from: `${LIST}:69 rows · data/sample/recording.json design.builds` },
  { key: "one", label: "One build", from: `${LIST}:69 rows · data/sample/states/design-one.json` },
  { key: "private", label: "A private build", from: `${LIST}:84 Private · data/sample/states/design-private.json` },
  { key: "shared", label: "A shared build", from: `${LIST}:86 Shared · data/sample/states/design-shared.json` },
  { key: "empty", label: "No builds yet", from: `${LIST}:44 none · data/sample/states/design-empty.json` },
]);
type ListState = (typeof DESIGN_LIST_STATES.list)[number]["key"];

export function DesignListRoute() {
  return (
    <StatePage states={DESIGN_LIST_STATES}>
      {(state: ListState) => (
        <Frame>
          <DesignListView project={PROJECT} builds={DESIGN_LISTS[state]} timeZone={TIME_ZONE} now={NOW} />
        </Frame>
      )}
    </StatePage>
  );
}

/** The viewer's states: the build's own, or a recorded build in the state named; gone is the API's 404. */
export const DESIGN_BUILD_STATES = pageStates("Design build", [
  { key: "no-options", label: "No options", from: `${VIEW}:196 pages · recording design.details (no manifest options)` },
  { key: "options", label: "Options", from: `${VIEW}:169 options side by side · recording design.details (manifest options)` },
  { key: "shared", label: "Shared", from: `${VIEW}:138 share on, Copy · recording design.details (share.on)` },
  { key: "private", label: "Private", from: `${VIEW}:134 one line · recording design.shareRefused (409)` },
  { key: "gone", label: "Gone", from: `${VIEW}:225 DesignBuildGone · recording design.gone (404)` },
]);
type BuildState = (typeof DESIGN_BUILD_STATES.list)[number]["key"];

/**
 * A direction's frame in the design: its recorded screenshot at its full height (no scroll inside the frame), drawn
 * without the options page's own bar (its top 139 of 360 px: the decision, the switcher, the throw-away note), as
 * production's frame shows the page once the options page drops that bar when framed (owed, `draft.md`).
 */
const BAR_SHARE = `${(-139 / 360) * 100}%`;
function shotOf(d: { key: string; label: string }) {
  const shot = DIRECTION_SHOTS[d.key];
  if (!shot) return null;
  return (
    <Image
      src={shot}
      alt={`${d.label}, as the build draws it at 360 px`}
      style={{ display: "block", width: "100%", height: "auto", marginTop: BAR_SHARE }}
    />
  );
}

function Viewer({ detail }: { detail: DesignDetail }) {
  const { build, manifest } = detail;
  // Production posts `…/share {on}` and draws the answer; the design keeps the change in this page.
  const [share, setShare] = useState({ on: build.share.on, url: build.share.url ?? null });
  return (
    <DesignBuildView
      project={PROJECT}
      build={build}
      manifest={manifest}
      share={share}
      onShare={(on) => setShare(on ? { on: true, url: madeShareUrl(build) } : { on: false, url: null })}
      frameOf={shotOf}
      timeZone={TIME_ZONE}
      now={NOW}
    />
  );
}

export function DesignBuildRoute({ id }: { id: string }) {
  const own = DESIGN_PART.details[id];
  const implied: BuildState = own ? kindOf(own.build) : "gone";
  return (
    <StatePage states={DESIGN_BUILD_STATES} implied={implied}>
      {(state: BuildState) => (
        <Frame>
          {state === "gone" ? (
            <DesignBuildGone project={PROJECT} projectName={RECORDING.shell.project.name} />
          ) : (
            <Viewer key={`${state}:${id}`} detail={detailFor(state as BuildKind, id)} />
          )}
        </Frame>
      )}
    </StatePage>
  );
}
