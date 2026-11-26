"use client";

import { useState } from "react";

import { SHARING } from "@/content/sharing";
import { setItemShare } from "@/lib/sharing/actions";
import { SHARE_STATES, type ItemShare, type ShareState, type ShareTarget } from "@/lib/sharing/model";
import { Copy } from "@/sikstack/frame";
import { Button, FieldError } from "@/sikstack/ui";

/**
 * A member's sharing switch for one item (P75), the design builds' share control reused (`DesignViewer`: one
 * change at a time, the busy label on the pressed button, the answer drawn, one line on a failure): Members /
 * Anyone with the link / Public, the state's one line under it, and while the link is on, the link and its
 * Copy. Turning the link off (Members or Public) kills it; turning it on again makes a new one. A chapter's
 * switch sets its book's (`share.kind === "book"`), said in one line. Only a member's read carries `share`,
 * so a visitor or a link reader never draws it.
 */
export function ShareControl({ target, share: initial }: { target: ShareTarget; share: ItemShare }) {
  const [share, setShare] = useState<ItemShare>(initial);
  const [busy, setBusy] = useState<ShareState | null>(null);
  const [failed, setFailed] = useState(false);

  async function change(state: ShareState) {
    if (busy || state === share.state) return;
    setBusy(state);
    setFailed(false);
    try {
      const answer = await setItemShare(target, state);
      if (answer.ok) setShare(answer.share);
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="read-end item-share" aria-labelledby="item-share-head">
      <h2 id="item-share-head" className="end-next-title">
        {SHARING.label}
      </h2>
      <div className="cluster gap-2" role="group" aria-label={SHARING.label}>
        {SHARE_STATES.map((state) => (
          <Button
            key={state}
            variant={share.state === state ? "primary" : "default"}
            aria-pressed={share.state === state}
            busy={busy === state}
            busyLabel={SHARING.changing}
            disabled={busy !== null}
            onClick={() => void change(state)}
            title={SHARING.states[state]}
          >
            {SHARING.short[state]}
          </Button>
        ))}
      </div>
      <p className="meta item-share-line">{SHARING.means[share.state]}</p>
      {share.kind === "book" ? <p className="meta">{SHARING.book}</p> : null}
      {share.state === "link" && share.url ? (
        <div className="design-share-on">
          <Copy text={share.url} label={SHARING.copyLabel} />
        </div>
      ) : null}
      {failed ? <FieldError role="alert">{SHARING.failed}</FieldError> : null}
    </section>
  );
}
