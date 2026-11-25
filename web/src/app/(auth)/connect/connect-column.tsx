"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { CONNECT_COPY, CONNECT_TITLES } from "@/content/connect";
import { buttonClass, Swap } from "@/sikstack/ui";
import {
  codeGroups,
  codeOfNext,
  connectPath,
  isConfirm,
  phaseAfterConnect,
  phaseAfterDecline,
  projectHref,
  splitEmail,
  type ConnectPhase,
  type ConnectView,
} from "@/lib/connect/model";

import { useAuthEmail } from "../auth-email";

/**
 * The connect page's column (job 09, `ConnectColumn.dc.html`), every product state:
 *
 * - *Confirm* (out, ready, connecting, error): the code first, the server error's notice, the
 *   question and its one sentence, the install, the org choice (more than one org only), the
 *   action pair. Signed out the pair is Create account and Sign in, links that carry this page
 *   as `next`; signed in it is Don't connect and Connect.
 * - Connecting: Connect shows `Connecting…` in its own width (`data-busy`), both buttons and the
 *   radios are disabled, the column is `aria-busy`; a second press does nothing, and an answer
 *   applies only to the send that started it. Success is Connected; a failure keeps the screen
 *   with the notice, Connect keeping its name.
 * - *Outcomes* (waitlisted, connected, declined, already, other, expired): the title, focused on
 *   arrival, a panel with one sentence and at most one way on. Another account's sentence names
 *   `/sikstack:sign-in release` (which frees the install for a new code), and its Sign out signs
 *   out and reloads this page (signed out, the same code).
 * - Signed in, the account a Connect uses shows once, right under the action pair, with Use
 *   another account: the same sign-out, back to this code signed out.
 * - Waitlisted comes from the `(auth)` layout's memory: a sign-up or sign-in sent from this
 *   page that answered "waitlisted" for this code (`useAuthEmail().waitlisted`).
 */
export function ConnectColumn({ initial }: { initial: ConnectView }) {
  const { waitlisted } = useAuthEmail();
  const [phase, setPhase] = useState<ConnectPhase>(initial.phase);
  const [org, setOrg] = useState<string>(initial.account?.orgs[0]?.id ?? "");
  const [projectId, setProjectId] = useState<string | null>(initial.project.id);
  const [connectedName, setConnectedName] = useState<string | null>(null);
  const sendRef = useRef(0);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const waitEmail =
    phase === "out" && waitlisted && codeOfNext(waitlisted.next) === initial.code
      ? waitlisted.email
      : null;
  const shown: ConnectPhase = waitEmail ? "waitlisted" : phase;
  const confirm = isConfirm(shown);

  useEffect(() => {
    // An outcome replaces the column the focus was in: put it on the title.
    if (!isConfirm(shown)) titleRef.current?.focus();
  }, [shown]);

  const busy = shown === "connecting";
  const orgs = initial.account?.orgs ?? [];
  const picked = orgs.find((o) => o.id === org) ?? orgs[0];
  const orgName = picked?.name ?? "";
  // The new project a Connect makes in the picked org, then the one the server made.
  const project = connectedName ?? picked?.project ?? initial.project.name;

  async function send(action: "approve" | "decline"): Promise<number | null> {
    try {
      const res = await fetch("/api/auth/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: initial.code,
          action,
          orgId: action === "approve" && orgs.length > 1 ? org : null,
        }),
      });
      if (res.ok && action === "approve") {
        const body = (await res.json().catch(() => null)) as {
          project?: { id?: unknown; name?: unknown };
        } | null;
        if (typeof body?.project?.id === "string") setProjectId(body.project.id);
        if (typeof body?.project?.name === "string") setConnectedName(body.project.name);
      }
      return res.status;
    } catch {
      return null;
    }
  }

  async function connect() {
    if (phase !== "ready" && phase !== "error") return; // a second press does nothing
    const id = ++sendRef.current;
    setPhase("connecting");
    const status = await send("approve");
    if (sendRef.current === id) setPhase(phaseAfterConnect(status));
  }

  async function decline() {
    if (phase !== "ready" && phase !== "error") return;
    const id = ++sendRef.current;
    const status = await send("decline");
    if (sendRef.current === id) setPhase(phaseAfterDecline(status));
  }

  async function signOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.reload();
    }
  }

  if (confirm) {
    const signedIn = shown !== "out";
    const [head, tail] = codeGroups(initial.code);
    const next = encodeURIComponent(connectPath(initial.code));
    const install = initial.install;
    const setup = splitEmail(install?.email ?? "");
    const me = splitEmail(initial.account?.email ?? "");
    return (
      <div className="signin-col" aria-busy={busy ? "true" : "false"}>
        <div className="stack gap-5">
          <div className="sk-code">
            <p className="sk-code-label">{CONNECT_COPY.codeLabel}</p>
            <p className="sk-code-value">
              <span className="sk-code-group">{head}</span>
              <wbr />
              <span className="sk-code-group">{tail}</span>
            </p>
          </div>
          {shown === "error" && (
            <p className="notice notice-danger" role="alert">
              {CONNECT_COPY.error}
            </p>
          )}
          <div className="stack gap-2">
            <h1>{CONNECT_COPY.title}</h1>
            {signedIn ? (
              <p>
                {CONNECT_COPY.signedIn.before}
                <span className="strong">{project}</span>
                {CONNECT_COPY.signedIn.middle}
                <span className="strong">{orgName}</span>
                {CONNECT_COPY.signedIn.after}
              </p>
            ) : (
              <p>{CONNECT_COPY.signedOut}</p>
            )}
          </div>
          <div className="panel">
            <dl className="sk-facts">
              <div className="row">
                <dt>{CONNECT_COPY.facts.install}</dt>
                <dd className="mono">{install?.id}</dd>
              </div>
              <div className="row">
                <dt>{CONNECT_COPY.facts.plugin}</dt>
                <dd>{CONNECT_COPY.facts.pluginValue(install?.version ?? "")}</dd>
              </div>
              <div className="row">
                <dt>{CONNECT_COPY.facts.setUp}</dt>
                <dd>{install?.setUp}</dd>
              </div>
              <div className="row">
                <dt>{CONNECT_COPY.facts.setupEmail}</dt>
                <dd>
                  <span>{setup.local}</span>
                  <wbr />
                  <span>{setup.domain}</span>
                </dd>
              </div>
            </dl>
          </div>
          {signedIn && orgs.length > 1 && (
            <fieldset className="field">
              <legend className="label">{CONNECT_COPY.org}</legend>
              {orgs.map((o) => (
                <label className="check" key={o.id}>
                  <input
                    type="radio"
                    name="connect-org"
                    value={o.id}
                    checked={o.id === org}
                    disabled={busy}
                    onChange={() => setOrg(o.id)}
                  />
                  <span>{o.name}</span>
                </label>
              ))}
            </fieldset>
          )}
          {signedIn ? (
            <div className="stack gap-1">
              <div className="sk-actions">
                <button
                  type="button"
                  className={buttonClass()}
                  disabled={busy}
                  onClick={decline}
                >
                  {CONNECT_COPY.decline}
                </button>
                <button
                  type="button"
                  className={buttonClass("primary")}
                  data-busy={busy ? "true" : "false"}
                  disabled={busy}
                  onClick={connect}
                >
                  <Swap labels={[CONNECT_COPY.connect, CONNECT_COPY.connecting]} />
                </button>
              </div>
              <p className="signin-wait-text">
                <span className="dim">{CONNECT_COPY.signedInAs}</span>{" "}
                <span className="connect-addr strong">
                  <span>{me.local}</span>
                  <wbr />
                  <span>{me.domain}</span>
                </span>{" "}
                <button type="button" className="link link-row" disabled={busy} onClick={signOut}>
                  {CONNECT_COPY.useAnotherAccount}
                </button>
              </p>
            </div>
          ) : (
            <div className="sk-actions">
              <Link href={`/signup?next=${next}`} className={buttonClass()}>
                {CONNECT_COPY.createAccount}
              </Link>
              <Link href={`/login?next=${next}`} className={buttonClass("primary")}>
                {CONNECT_COPY.signIn}
              </Link>
            </div>
          )}
        </div>
      </div>
    );
  }

  const title = CONNECT_TITLES[shown as keyof typeof CONNECT_TITLES];
  const words = CONNECT_COPY.outcomes;
  const command = <span className="cmd-inline">{CONNECT_COPY.command}</span>;
  let sentence: ReactNode = null;
  let wayOn: ReactNode = null;
  if (shown === "waitlisted") {
    const mail = splitEmail(waitEmail ?? "");
    sentence = (
      <p className="block-text signin-wait-text">
        {words.waitlisted.before}
        <span className="connect-addr">
          <span>{mail.local}</span>
          <wbr />
          <span>{mail.domain}</span>
        </span>
        {words.waitlisted.middle}
        {command}
        {words.waitlisted.after}
      </p>
    );
  } else if (shown === "connected" || shown === "already") {
    sentence = (
      <p className="block-text">
        {shown === "connected" ? words.connected(project) : words.already(project)}
      </p>
    );
    if (projectId) {
      wayOn = (
        <p className="cluster gap-1">
          <a className="link link-row" href={projectHref(projectId)}>
            {CONNECT_COPY.openProject(project)}
          </a>
        </p>
      );
    }
  } else if (shown === "declined") {
    sentence = <p className="block-text">{words.declined}</p>;
  } else if (shown === "other") {
    sentence = (
      <p className="block-text">
        {words.other.before}
        <span className="cmd-inline">{CONNECT_COPY.releaseCommand}</span>
        {words.other.after}
      </p>
    );
    wayOn = (
      <p className="cluster gap-1">
        <button type="button" className="link link-row" onClick={signOut}>
          {CONNECT_COPY.signOut}
        </button>
      </p>
    );
  } else {
    sentence = (
      <p className="block-text">
        {words.expired.before}
        {command}
        {words.expired.after}
      </p>
    );
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
