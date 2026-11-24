"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { publishToast } from "@/sikstack/shell";
import { buttonClass, Swap } from "@/sikstack/ui";
import { splitEmail } from "@/lib/connect/model";

// Applied: `@/content/org` (this design keeps the new words at `next/content/org.ts`).
import { INVITE } from "../content/org";
import { invitePath, isInviteConfirm, type InvitePagePhase, type InviteView } from "./model";

const ORG_HOME = "/dashboard";

export interface InviteColumnProps {
  initial: InviteView;
  /** The join: adds the signed-in account to the org as a member (approved, off the waitlist) and makes it the
   * active org; the page then lands on its home. */
  join: (code: string) => Promise<{ ok: boolean }>;
  /** Where Already a member's way on posts (the org switch route, as the org menu's). */
  orgRoute: string;
}

/** An address in a sentence or a fact: it moves to the next line whole, breaking before its @ only when longer. */
function Addr({ email }: { email: string }) {
  const { local, domain } = splitEmail(email);
  return (
    <span className="connect-addr">
      <span>{local}</span>
      <wbr />
      <span>{domain}</span>
    </span>
  );
}

/**
 * The invite link's column (`/invite?code=…`, P78-s2.S2's design), in the sign-in frame beside `/connect` and drawn
 * by its classes (`signin.css`, `connect.css`):
 *
 * - *Confirm* (out, ready, joining, failed): the title naming the org, then signed out one sentence naming the
 *   address the invite is bound to, the facts (Invited by; signed in, Invite for too), and the action pair: Create account and
 *   Sign in, links that carry this page as `next`. Signed in as that address: the facts and Join <org>. Joining:
 *   the label swaps at its width, the column is `aria-busy`, a second press does nothing; a failure keeps the
 *   screen with the notice over the title. Joined: the org's home, with the toast.
 * - *Outcomes* (other, member, expired): the title, focused on arrival, a panel with one sentence and at most one
 *   way on. Another account's Sign out signs out and reloads this page (signed out, the same code).
 */
export function InviteColumn({ initial, join, orgRoute }: InviteColumnProps) {
  const router = useRouter();
  const [phase, setPhase] = useState<InvitePagePhase>(initial.phase);
  const sendRef = useRef(0);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const confirm = isInviteConfirm(phase);
  const org = initial.org.name;

  useEffect(() => {
    if (!confirm) titleRef.current?.focus();
  }, [confirm]);

  async function onJoin() {
    if (phase !== "ready" && phase !== "failed") return;
    const id = ++sendRef.current;
    setPhase("joining");
    let ok = false;
    try {
      ok = (await join(initial.code)).ok;
    } catch {
      ok = false;
    }
    if (sendRef.current !== id) return;
    if (!ok) {
      setPhase("failed");
      return;
    }
    publishToast(INVITE.joined(org));
    router.replace(ORG_HOME);
    router.refresh();
  }

  async function signOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.reload();
    }
  }

  if (confirm) {
    const busy = phase === "joining";
    const next = encodeURIComponent(invitePath(initial.code));
    return (
      <div className="signin-col" aria-busy={busy ? "true" : "false"}>
        <div className="stack gap-5">
          {phase === "failed" ? (
            <p className="notice notice-danger" role="alert">
              {INVITE.failed(org)}
            </p>
          ) : null}
          <div className="stack gap-2">
            <h1>{INVITE.title(org)}</h1>
            {phase === "out" ? (
              <p>
                {INVITE.signedOut.before}
                <span className="strong">
                  <Addr email={initial.email} />
                </span>
                {INVITE.signedOut.after}
              </p>
            ) : null}
          </div>
          <div className="panel">
            <dl className="sk-facts">
              <div className="row">
                <dt>{INVITE.facts.invitedBy}</dt>
                <dd>
                  <Addr email={initial.invitedBy} />
                </dd>
              </div>
              {phase !== "out" ? (
                // Signed out, the sentence over the facts names the address already.
                <div className="row">
                  <dt>{INVITE.facts.for}</dt>
                  <dd>
                    <Addr email={initial.email} />
                  </dd>
                </div>
              ) : null}
            </dl>
          </div>
          {phase === "out" ? (
            <div className="sk-actions">
              <Link href={`/signup?next=${next}`} className={buttonClass()}>
                {INVITE.createAccount}
              </Link>
              <Link href={`/login?next=${next}`} className={buttonClass("primary")}>
                {INVITE.signIn}
              </Link>
            </div>
          ) : (
            <div className="sk-actions">
              <button
                type="button"
                className={buttonClass("primary")}
                data-busy={busy ? "true" : "false"}
                aria-busy={busy ? true : undefined}
                disabled={busy}
                onClick={() => void onJoin()}
              >
                <Swap labels={[INVITE.join(org), INVITE.joining]} />
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const words = INVITE.outcomes;
  let title: string;
  let sentence: ReactNode;
  let wayOn: ReactNode = null;
  if (phase === "other") {
    title = words.other.title;
    sentence = (
      <p className="block-text signin-wait-text">
        {words.other.before}
        <span className="strong">
          <Addr email={initial.email} />
        </span>
        {words.other.after}
      </p>
    );
    wayOn = (
      <p className="cluster gap-1">
        <button type="button" className="link link-row" onClick={() => void signOut()}>
          {words.other.signOut}
        </button>
      </p>
    );
  } else if (phase === "member") {
    title = words.member.title;
    sentence = <p className="block-text">{words.member.text(org)}</p>;
    // The org switch route confirms the membership, sets the org and lands on its home, as the org menu's pick.
    wayOn = (
      <form className="cluster gap-1" method="post" action={orgRoute}>
        <button type="submit" name="org" value={initial.org.id} className="link link-row">
          {words.member.open(org)}
        </button>
      </form>
    );
  } else {
    title = words.expired.title;
    sentence = <p className="block-text">{words.expired.text(org)}</p>;
  }
  return (
    <div className="signin-col">
      <div className="stack gap-4">
        <h1 ref={titleRef} tabIndex={-1}>
          {title}
        </h1>
        <div className="stack gap-1">
          <div className="panel">
            <div className="panel-body block">{sentence}</div>
          </div>
          {wayOn}
        </div>
      </div>
    </div>
  );
}
