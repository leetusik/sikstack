import { WS_SLICE } from "@/content/workspace/slice";
import { StateBlock, type StateModel } from "@/sikstack/states";
import {
  BackRow,
  WsRetrySync,
  type WsBack,
  type WsSyncLine,
} from "@/sikstack/workspace/frame";

/**
 * Not found and Error (`Slice.dc.html`; F49), directly under the back row: the back link reads the phase's id,
 * and the sync line stands when the page knows it (null: the workspace's own read failed too, so there is no
 * line to draw, but its bar while Try again reads the page again).
 */
export function SliceMissing({
  back,
  line,
  state,
}: {
  back: WsBack;
  line: WsSyncLine | null;
  state: StateModel;
}) {
  return (
    <div className="column">
      <div>
        {line ? (
          <BackRow
            {...back}
            ariaLabel={WS_SLICE.back(back.label)}
            line={line}
          />
        ) : (
          <div className="ws-top">
            <a
              className="back"
              href={back.href}
              aria-label={WS_SLICE.back(back.label)}
            >
              {back.label}
            </a>
            <WsRetrySync />
          </div>
        )}
        <StateBlock state={state} />
      </div>
    </div>
  );
}
