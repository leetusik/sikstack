import { WS_SYNC } from "@/content/workspace/frame";
import { when, type FormatOptions } from "@/lib/format";

/** The read model's `sync`: how fresh the project's copy of its workspace is. */
export interface WsSyncState {
  state: "unlinked" | "never" | "fresh" | "behind";
  at: string | null;
}

/** The sync line (frame.md F40, `WS.syncLine`): a page passes it to `WsNav` or `WsSync` and never formats it. */
export interface WsSyncLine {
  state: WsSyncState["state"];
  text: string;
  cls: string;
  version: string;
}

/**
 * The line a page draws when the read that carries the sync facts failed: the head stands and says nothing of a sync
 * it could not read (no figure made up).
 */
export const NO_LINE: WsSyncLine = {
  state: "fresh",
  text: "",
  cls: "",
  version: "",
};

/**
 * The line for a workspace's `sync` and `version`. Fresh (under 24 h, the server's cut): a check,
 * `Synced 2m ago`, then the version. Behind: a ring, `Last synced 4d ago` (a date past a week, in the viewer's
 * zone through `options`). Never synced and not linked have no line: `WsNav` draws the page's one panel. No
 * `sync` at all is a workspace not linked.
 */
export function wsSyncLine(
  sync: WsSyncState | null | undefined,
  version: string | null | undefined,
  options: FormatOptions = {},
): WsSyncLine {
  if (!sync || sync.state === "unlinked")
    return {
      state: "unlinked",
      text: WS_SYNC.unlinked,
      cls: "status status-idle",
      version: "",
    };
  if (sync.state === "never")
    return {
      state: "never",
      text: WS_SYNC.never,
      cls: "status status-idle",
      version: "",
    };
  const ago = when(sync.at, options);
  return sync.state === "behind"
    ? {
        state: "behind",
        text: WS_SYNC.behind(ago),
        cls: "status status-idle",
        version: version ?? "",
      }
    : {
        state: "fresh",
        text: WS_SYNC.fresh(ago),
        cls: "status status-done",
        version: version ?? "",
      };
}
