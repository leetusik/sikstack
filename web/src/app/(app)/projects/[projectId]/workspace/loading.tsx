import { headers } from "next/headers";

import {
  AgendaLoading,
  workspaceHrefs,
  workspaceProjectId,
} from "@/sikstack/workspace/agenda";
import { WsNav, type WsSyncLine } from "@/sikstack/workspace/frame";
import { REQUEST_PATH_HEADER } from "@/lib/next-path";

// The Agenda while it loads (`Agenda.dc.html`, Loading; frame.md F49): the Shell is complete, `WsNav` stands with
// its sync line as a bar, and the first part keeps its head over five skeleton rows. It reads nothing; the
// project's id for the three places comes from the request's path (loading gets no params).
const LOADING_LINE: WsSyncLine = {
  state: "fresh",
  text: "",
  cls: "",
  version: "",
};

export default async function AgendaLoadingPage() {
  const project = workspaceProjectId(
    (await headers()).get(REQUEST_PATH_HEADER),
  );
  return (
    <div className="column">
      <WsNav
        current="agenda"
        line={LOADING_LINE}
        hrefs={workspaceHrefs(project ?? "")}
        loading
      />
      <AgendaLoading headId="agenda-loading-open" />
    </div>
  );
}
