"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { publishToast } from "@/sikstack/shell";
import { StackTable } from "@/sikstack/feedback/stack-table";
import {
  Badge,
  Block,
  BlockText,
  Button,
  buttonClass,
  Cluster,
  Field,
  FieldError,
  Label,
  Notice,
  Panel,
  PanelHead,
} from "@/sikstack/ui";
import { date, plural, type FormatOptions } from "@/lib/format";

import { MEMBERS } from "@/content/org";
import {
  inviteFieldError,
  inviteFormOpen,
  invitesNewestFirst,
  looksLikeEmail,
  membersInOrder,
  type InvitePhase,
  type InviteResult,
  type InviteRow,
  type MemberRow,
  type OrgRole,
} from "./model";

export interface MembersViewProps {
  org: string;
  /** The signed-in account's address and its role in the org. */
  me: { email: string; role: OrgRole };
  members: readonly MemberRow[];
  /** The pending invites; an owner's view only (a member's view has none). */
  invites: readonly InviteRow[];
  /** The page's actions (an owner's): send an invite, revoke one, remove a member. */
  invite: (email: string) => Promise<InviteResult>;
  revoke: (id: string) => Promise<{ ok: boolean }>;
  remove: (id: string) => Promise<{ ok: boolean }>;
  /** A member's: leave the org (on success the page moves to the next org's home, so it answers only a refusal). */
  leave: () => Promise<{ ok: boolean } | undefined>;
  format: FormatOptions;
  /** The invite form's first phase and address (the page opens with the form closed). */
  phase?: InvitePhase;
  draft?: string;
}

const M = MEMBERS.members;
const I = MEMBERS.invites;

/**
 * Members (`/members`, P78-s2.S2's design): the org's people, in two panels.
 *
 * - Members: every member's address, role (Owner, Member) and the day they joined; the signed-in account's row
 *   marked You. The owner first. Membership ends in Revoke's pattern (P78-s2.F1): in an owner's view each member's
 *   row ends with Remove (no confirm; the row goes and the toast says so); in a member's view its own row ends with
 *   Leave, which lands on its next org's home. An owner's row has neither (an org keeps its owner).
 * - Invites (an owner's view only): the head's Invite opens the form in place (Email, Cancel, Send invite), as
 *   Projects' New project does on org home; the pending invites, newest first, each with the day it was sent, the
 *   day it stops working, and Revoke at the row's end. With none, the empty line, and Invite is the page's primary.
 * - A send: the address is checked first (not an address: the field's error, nothing sent); the API's refusals
 *   (a member already, invited already) are the field's error too, the address kept to edit; a send with no
 *   answer is the notice over the field. Sent: the form closes, the invite is the table's first row, and the
 *   toast names the address. Revoke takes the row out and says so in the toast.
 * - Under 48em of its own width each table stacks (`table-stack`, F14): the address first, the rest on the line
 *   under it, Revoke at that line's end.
 */
export function MembersView({
  org,
  me,
  members,
  invites: initialInvites,
  invite,
  revoke,
  remove,
  leave,
  format,
  phase: initialPhase = "list",
  draft: initialDraft = "",
}: MembersViewProps) {
  const uid = useId();
  const owner = me.role === "owner";
  const [phase, setPhase] = useState<InvitePhase>(initialPhase);
  const [draft, setDraft] = useState(initialDraft);
  const [invites, setInvites] = useState<InviteRow[]>(() => invitesNewestFirst(initialInvites));
  const [revoking, setRevoking] = useState<string | null>(null);
  const [people, setPeople] = useState<MemberRow[]>(() => membersInOrder(members));
  const [ending, setEnding] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const inviteRef = useRef<HTMLButtonElement>(null);
  const focus = useRef<"email" | "invite" | null>(null);

  useEffect(() => {
    if (focus.current === "email") emailRef.current?.focus();
    if (focus.current === "invite") inviteRef.current?.focus();
    focus.current = null;
  }, [phase]);

  const open = inviteFormOpen(phase);
  const busy = phase === "sending";
  const refusal = inviteFieldError(phase);
  const address = draft.trim();
  const error =
    refusal === "address"
      ? I.errors.address
      : refusal === "member"
        ? I.errors.member(address, org)
        : refusal === "invited"
          ? I.errors.invited(address)
          : refusal === "limit"
            ? I.errors.limit
            : refusal === "recipient"
              ? I.errors.recipient(address)
              : null;
  const ids = { email: `${uid}-email`, error: `${uid}-error`, notice: `${uid}-notice` };

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (!looksLikeEmail(draft)) {
      focus.current = "email";
      setPhase("address");
      return;
    }
    setPhase("sending");
    let result: InviteResult;
    try {
      result = await invite(address);
    } catch {
      result = { ok: false, reason: "failed" };
    }
    if (result.ok) {
      const sent = result.invite;
      setInvites((rows) => invitesNewestFirst([sent, ...rows.filter((r) => r.id !== sent.id)]));
      setDraft("");
      focus.current = "invite";
      setPhase("list");
      publishToast(I.sent(sent.email));
      return;
    }
    focus.current = "email";
    setPhase(result.reason);
  };

  const drop = async (row: InviteRow) => {
    if (revoking) return;
    setRevoking(row.id);
    let ok = false;
    try {
      ok = (await revoke(row.id)).ok;
    } catch {
      ok = false;
    }
    setRevoking(null);
    if (ok) {
      setInvites((rows) => rows.filter((r) => r.id !== row.id));
      publishToast(I.revoked(row.email));
    }
  };

  const dropMember = async (row: MemberRow) => {
    if (ending) return;
    setEnding(row.id);
    let ok = false;
    try {
      ok = (await remove(row.id)).ok;
    } catch {
      ok = false;
    }
    setEnding(null);
    if (ok) {
      setPeople((rows) => rows.filter((r) => r.id !== row.id));
      publishToast(M.removed(row.email));
    }
  };

  const leaveOrg = async (row: MemberRow) => {
    if (ending) return;
    setEnding(row.id);
    let refused = true;
    try {
      // A left org moves the page to the next org's home; only a refusal comes back.
      refused = (await leave())?.ok === false;
    } catch {
      refused = true;
    }
    setEnding(null);
    if (refused) publishToast(M.leaveFailed(org));
  };

  /** The control a row ends with: Remove (an owner's view, a member's row), Leave (a member's own row), or none. */
  const control = (m: MemberRow): "remove" | "leave" | null =>
    owner ? (m.role === "owner" ? null : "remove") : m.email === me.email ? "leave" : null;
  const controls = people.some((m) => control(m) !== null);

  return (
    <div className="column">
      <header className="page-top">
        <div className="page-head">
          <div className="page-title">
            <h1>{MEMBERS.title}</h1>
            <p className="meta">{plural(people.length, M.unit)}</p>
          </div>
        </div>
      </header>

      <Panel className="org-members" aria-label={M.heading}>
        <StackTable>
          <thead>
            <tr>
              <th scope="col">{M.email}</th>
              <th scope="col">{M.role}</th>
              <th scope="col">{M.joined}</th>
              {controls ? (
                <th scope="col" className="at-end">
                  <span className="sr-only">{owner ? M.remove : M.leave}</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {people.map((m) => (
              <tr key={m.id}>
                <td className="is-main">
                  <span className="cluster gap-2">
                    <span className="strong" style={{ overflowWrap: "anywhere" }}>
                      {m.email}
                    </span>
                    {m.email === me.email ? <Badge>{M.you}</Badge> : null}
                  </span>
                </td>
                <td className="nowrap">{MEMBERS.roles[m.role]}</td>
                <td className="nowrap">
                  <span className="sr-only">{M.joined} </span>
                  {date(m.joinedAt, format)}
                </td>
                {controls ? (
                  <td className="at-end to-end">
                    {control(m) === "remove" ? (
                      <Button
                        variant="quiet"
                        aria-label={M.removeLabel(m.email)}
                        disabled={ending !== null}
                        busy={ending === m.id}
                        onClick={() => void dropMember(m)}
                      >
                        {M.remove}
                      </Button>
                    ) : control(m) === "leave" ? (
                      <Button
                        variant="quiet"
                        aria-label={M.leaveLabel(org)}
                        disabled={ending !== null}
                        busy={ending === m.id}
                        onClick={() => void leaveOrg(m)}
                      >
                        {M.leave}
                      </Button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </StackTable>
      </Panel>

      {owner ? (
        <Panel aria-label={I.heading}>
          <PanelHead>
            <h2 style={{ flex: "1 0 auto" }}>{I.heading}</h2>
            {invites.length > 0 ? <p className="meta">{plural(invites.length, I.unit)}</p> : null}
            <button
              ref={inviteRef}
              type="button"
              className={buttonClass(invites.length === 0 && phase === "list" ? "primary" : "default")}
              aria-expanded={open}
              disabled={busy}
              onClick={() => {
                if (phase === "list") {
                  focus.current = "email";
                  setPhase("open");
                } else {
                  setDraft("");
                  setPhase("list");
                }
              }}
            >
              {I.invite}
            </button>
          </PanelHead>
          {open ? (
            <form className="panel-body has-rule stack gap-2" noValidate onSubmit={(e) => void send(e)}>
              {phase === "failed" ? (
                <Notice danger role="alert" id={ids.notice}>
                  {I.failed}
                </Notice>
              ) : null}
              <Field>
                <Label htmlFor={ids.email}>{I.emailLabel}</Label>
                <div className="form-row" style={{ alignItems: "flex-start" }}>
                  <Field>
                    <input
                      ref={emailRef}
                      className="input"
                      id={ids.email}
                      type="email"
                      name="email"
                      autoComplete="off"
                      spellCheck={false}
                      value={draft}
                      disabled={busy}
                      aria-invalid={error ? "true" : undefined}
                      aria-describedby={error ? ids.error : phase === "failed" ? ids.notice : undefined}
                      onChange={(e) => {
                        setDraft(e.target.value);
                        if (refusal) setPhase("open");
                      }}
                    />
                    {error ? (
                      <FieldError role="alert" id={ids.error}>
                        {error}
                      </FieldError>
                    ) : null}
                  </Field>
                  <Cluster style={{ marginLeft: "auto" }}>
                    <Button
                      disabled={busy}
                      onClick={() => {
                        focus.current = "invite";
                        setDraft("");
                        setPhase("list");
                      }}
                    >
                      {I.cancel}
                    </Button>
                    <Button type="submit" variant="primary" busy={busy} busyLabel={I.sending}>
                      {I.send}
                    </Button>
                  </Cluster>
                </div>
              </Field>
            </form>
          ) : null}
          {invites.length > 0 ? (
            <StackTable>
              <thead>
                <tr>
                  <th scope="col">{I.email}</th>
                  <th scope="col">{I.status}</th>
                  <th scope="col" className="at-end">
                    <span className="sr-only">{I.revoke}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {invites.map((r) => (
                  <tr key={r.id}>
                    <td className="is-main">
                      <span style={{ overflowWrap: "anywhere" }}>{r.email}</span>
                    </td>
                    <td className="nowrap">{I.expiresOn(date(r.expiresAt, format))}</td>
                    <td className="at-end to-end">
                      <Button
                        variant="quiet"
                        aria-label={I.revokeLabel(r.email)}
                        disabled={revoking !== null}
                        busy={revoking === r.id}
                        onClick={() => void drop(r)}
                      >
                        {I.revoke}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </StackTable>
          ) : (
            <Block className="panel-body has-rule">
              <BlockText>{I.empty}</BlockText>
            </Block>
          )}
        </Panel>
      ) : null}
    </div>
  );
}
