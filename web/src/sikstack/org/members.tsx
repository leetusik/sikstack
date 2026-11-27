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
  PanelBody,
  PanelHead,
} from "@/sikstack/ui";
import { date, plural, type FormatOptions } from "@/lib/format";

import { MEMBERS } from "@/content/org";
// P88-ms.S3's signed design, applied by P88-ms.S4: Members is a part of Org settings (`/settings`; `/members`
// redirects there), with no page head of its own (the Members panel has a head), Step down and the role note. The
// new words are `@/content/settings`.
import { SETTINGS } from "@/content/settings";
import {
  inviteFieldError,
  inviteFormOpen,
  invitesNewestFirst,
  looksLikeEmail,
  memberControls,
  membersInOrder,
  withMember,
  withOwner,
  type InvitePhase,
  type InviteResult,
  type InviteRow,
  type MemberRow,
  type MembershipResult,
  type OrgRole,
} from "./model";

export interface MembersViewProps {
  org: string;
  /** The signed-in account's address and its role in the org. */
  me: { email: string; role: OrgRole };
  members: readonly MemberRow[];
  /** The pending invites; an owner's view only (a member's view has none). */
  invites: readonly InviteRow[];
  /** The page's actions (an owner's): send an invite, revoke one, make a member an owner, remove a member. */
  invite: (email: string) => Promise<InviteResult>;
  revoke: (id: string) => Promise<{ ok: boolean }>;
  promote: (id: string) => Promise<{ ok: boolean }>;
  remove: (id: string) => Promise<MembershipResult>;
  /**
   * Leave the org, from the account's own row: a member's, or an owner's when the org has another owner (on
   * success the page moves to the next org's home, so it answers only a refusal).
   */
  leave: () => Promise<MembershipResult | undefined>;
  /** Step down to member, from the account's own row (an owner's, when the org has another owner). */
  stepDown: (id: string) => Promise<MembershipResult>;
  /** The account is a member now: the page draws a member's view (no invites, no danger zone). */
  onSteppedDown?: () => void;
  format: FormatOptions;
  /** The invite form's first phase and address (the page opens with the form closed). */
  phase?: InvitePhase;
  draft?: string;
}

const M = MEMBERS.members;
const I = MEMBERS.invites;

/** Make owner's toast: the member is an owner now, or it could not be made one. */
export function promoteToast(email: string, ok: boolean): string {
  return ok ? M.madeOwner(email) : M.makeOwnerFailed(email);
}

/** Remove's toast: the member is out, or it could not be removed (a refusal of any kind). */
export function removeToast(email: string, result: MembershipResult): string {
  return result.ok ? M.removed(email) : M.removeFailed(email);
}

/** Step down's toast: a member now, the org's last owner (409 `last_owner`), or anything else, try again. */
export function stepDownToast(org: string, result: MembershipResult): string {
  const S = SETTINGS.members;
  return result.ok ? S.steppedDown(org) : result.reason === "last_owner" ? S.stepDownLastOwner(org) : S.stepDownFailed(org);
}

/** A refused Leave's toast: the org's last owner asks for another owner first; anything else, try again. */
export function leaveToast(org: string, result: MembershipResult): string {
  return result.reason === "last_owner" ? M.leaveLastOwner(org) : M.leaveFailed(org);
}

/**
 * Members (P78-s2.S2's design; a part of Org settings since P88-ms.S3's design, `/settings`): the org's people, in
 * two panels. The Members panel has its own head (Members, the count) and ends with the role note: what an owner and
 * a member can do. An owner's own row, when the org has another owner, ends with Step down before Leave (the same
 * pattern: no confirm, the toast); stepped down, the row reads Member and the page draws a member's view. The API's
 * `last_owner` (another owner stepped down or left meanwhile) is the toast, the row kept.
 *
 * - Members: every member's address, role (Owner, Member) and the day they joined; the signed-in account's row
 *   marked You. The owners first. Membership changes in Revoke's pattern (P78-s2.F1; no confirm, the toast says
 *   what happened): in an owner's view each member's row ends with Make owner (the row reads Owner, and moves up
 *   with the owners) and Remove (the row goes); the owner's own row ends with Leave when the org has another owner,
 *   and has nothing when it is the only one (an org keeps an owner); another owner's row has nothing (no one makes
 *   an owner a member again). In a member's view its own row ends with Leave. Leave lands on the account's next
 *   org's home (a fresh `Personal` org when it was the account's only one). A refusal (the org's last owner, or no
 *   answer) is the toast, the row kept.
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
  promote,
  remove,
  leave,
  stepDown,
  onSteppedDown,
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
  /** The row action under way, as `<control>:<row id>` (one at a time). */
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

  const promoteMember = async (row: MemberRow) => {
    if (ending) return;
    setEnding(`promote:${row.id}`);
    let ok = false;
    try {
      ok = (await promote(row.id)).ok;
    } catch {
      ok = false;
    }
    setEnding(null);
    if (ok) setPeople((rows) => withOwner(rows, row.id));
    publishToast(promoteToast(row.email, ok));
  };

  const dropMember = async (row: MemberRow) => {
    if (ending) return;
    setEnding(`remove:${row.id}`);
    let result: MembershipResult;
    try {
      result = await remove(row.id);
    } catch {
      result = { ok: false };
    }
    setEnding(null);
    if (result.ok) setPeople((rows) => rows.filter((r) => r.id !== row.id));
    publishToast(removeToast(row.email, result));
  };

  const stepDownSelf = async (row: MemberRow) => {
    if (ending) return;
    setEnding(`step-down:${row.id}`);
    let result: MembershipResult;
    try {
      result = await stepDown(row.id);
    } catch {
      result = { ok: false };
    }
    setEnding(null);
    if (result.ok) {
      setPeople((rows) => withMember(rows, row.id));
      onSteppedDown?.();
    }
    publishToast(stepDownToast(org, result));
  };

  const leaveOrg = async (row: MemberRow) => {
    if (ending) return;
    setEnding(`leave:${row.id}`);
    let result: MembershipResult | undefined;
    try {
      // A left org moves the page to the next org's home; only a refusal comes back.
      result = await leave();
    } catch {
      result = { ok: false };
    }
    setEnding(null);
    if (result?.ok !== false) return;
    publishToast(leaveToast(org, result));
  };

  /** The controls a row ends with (`memberControls`): Make owner and Remove, Leave, or none. */
  const control = (m: MemberRow) => memberControls(m, me, people);
  const controls = people.some((m) => control(m).length > 0);

  return (
    <>
      <Panel aria-label={SETTINGS.members.heading}>
        <PanelHead>
          <h2 style={{ flex: "1 0 auto" }}>{SETTINGS.members.heading}</h2>
          <p className="meta">{plural(people.length, M.unit)}</p>
        </PanelHead>
        <StackTable>
          <thead>
            <tr>
              <th scope="col">{M.email}</th>
              <th scope="col">{M.role}</th>
              <th scope="col">{M.joined}</th>
              {controls ? (
                <th scope="col" className="at-end">
                  <span className="sr-only">{M.actions}</span>
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
                    <span className="cluster gap-2 to-end">
                      {control(m).map((c) =>
                        c === "promote" ? (
                          <Button
                            key={c}
                            variant="quiet"
                            aria-label={M.makeOwnerLabel(m.email)}
                            disabled={ending !== null}
                            busy={ending === `promote:${m.id}`}
                            onClick={() => void promoteMember(m)}
                          >
                            {M.makeOwner}
                          </Button>
                        ) : c === "remove" ? (
                          <Button
                            key={c}
                            variant="quiet"
                            aria-label={M.removeLabel(m.email)}
                            disabled={ending !== null}
                            busy={ending === `remove:${m.id}`}
                            onClick={() => void dropMember(m)}
                          >
                            {M.remove}
                          </Button>
                        ) : c === "step-down" ? (
                          <Button
                            key={c}
                            variant="quiet"
                            aria-label={SETTINGS.members.stepDownLabel(org)}
                            disabled={ending !== null}
                            busy={ending === `step-down:${m.id}`}
                            onClick={() => void stepDownSelf(m)}
                          >
                            {SETTINGS.members.stepDown}
                          </Button>
                        ) : (
                          <Button
                            key={c}
                            variant="quiet"
                            aria-label={M.leaveLabel(org)}
                            disabled={ending !== null}
                            busy={ending === `leave:${m.id}`}
                            onClick={() => void leaveOrg(m)}
                          >
                            {M.leave}
                          </Button>
                        ),
                      )}
                    </span>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </StackTable>
        <PanelBody rule className="stack gap-1">
          {(["owner", "member"] as const).map((role) => (
            <p key={role} className="meta">
              <span className="strong">{SETTINGS.members.roles[role].name}</span>
              {SETTINGS.members.roles[role].text}
            </p>
          ))}
        </PanelBody>
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
    </>
  );
}
