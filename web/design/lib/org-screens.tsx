"use client";

import { useEffect, type ReactNode } from "react";

import { SKIP_TO_CONTENT } from "@/content";
import { publishToast, ShellOrgNameProvider, ToastRegion, type ShellOrg } from "@/sikstack/shell";
import { StateBlock } from "@/sikstack/states";
import { Legacy } from "@/sikstack/ui/boundary";
import { UiRoot } from "@/sikstack/ui/root";

import { Shell } from "@/sikstack/shell/shell";

import { MEMBERS as MEMBERS_WORDS } from "@/content/org";
import { InviteColumn } from "@/sikstack/org/invite";
import { MembersView } from "@/sikstack/org/members";
import type { InvitePagePhase, InvitePhase, InviteRow, MemberRow, OrgRole } from "@/sikstack/org/model";
import { NewOrgForm } from "@/sikstack/org/new-org";
import { DESIGN_MARK } from "./mark";
import {
  CURRENT_ORG,
  designCreate,
  designInvite,
  designJoin,
  designLeave,
  designPromote,
  designRemove,
  designRevoke,
  INVITE_VIEW,
  INVITES_MANY,
  ME,
  MEMBERS_MANY,
  NEW_ADDRESS,
  NOT_AN_ADDRESS,
  OTHER_ACCOUNT,
  OTHER_ORGS,
  OWNER,
  sentInvite,
} from "./org-data";
import { INVITE_STATES, MEMBERS_STATES, NEW_ORG_STATES, ORG_SWITCHER_STATES } from "./page-states";
import { NOW, PROJECT, RECORDING, TIME_ZONE } from "./recording";
import { StatePage } from "./states";

/**
 * The org surfaces' screens (P78-s2.S2's design): production's Shell (the org menu for every account, New org at its
 * foot, Members in the org rail) and the org components (`src/sikstack/org/`), on made data (`org-data.ts`). The page's
 * state widget sets each component's first phase; the components then run as production would, their actions
 * answered in the browser.
 */

const FORMAT = { timeZone: TIME_ZONE, now: NOW };
/** Where an org pick posts in the design (a static build has no route: the Frame's, as the other pages'). */
const ORG_ROUTE = "/org";

/** The app frame as `AppShell` draws it, with the account's orgs given. */
function OrgFrame({ orgs, children }: { orgs: ShellOrg[]; children: ReactNode }) {
  return (
    <UiRoot data-design={DESIGN_MARK}>
      <Legacy>
        <a className="kb-skip" href={SKIP_TO_CONTENT.href}>
          {SKIP_TO_CONTENT.label}
        </a>
      </Legacy>
      <div className="page">
        <div className="app">
          <div className="app-frame">
            <Shell
              org={RECORDING.shell.org}
              orgs={orgs}
              projects={[{ id: PROJECT, ...RECORDING.shell.project }]}
              email={ME}
              due={0}
              orgRoute={ORG_ROUTE}
            />
            <main id="main-content" className="app-main">
              <ShellOrgNameProvider name={RECORDING.shell.org.name}>{children}</ShellOrgNameProvider>
              <ToastRegion />
            </main>
          </div>
        </div>
      </div>
    </UiRoot>
  );
}

/** Opens the org menu as a click would (the Shell keeps it in its own state): the open-menu states. */
function OpenOrgMenu() {
  useEffect(() => {
    const trigger = document.querySelector<HTMLButtonElement>('[data-shell-menu="org"] > button');
    if (trigger?.getAttribute("aria-expanded") === "false") trigger.click();
  }, []);
  return null;
}

/** Publishes a toast once, on arrival (the states that show one). */
function Toast({ text }: { text: string }) {
  useEffect(() => {
    publishToast(text);
  }, [text]);
  return null;
}

// ── The org switcher, over org home's address ──────────────────────────────────────────────────

type SwitcherState = (typeof ORG_SWITCHER_STATES.list)[number]["key"];

export function OrgSwitcherRoute() {
  return (
    <StatePage states={ORG_SWITCHER_STATES}>
      {(state: SwitcherState) => (
        <OrgFrame key={state} orgs={state === "one" ? [CURRENT_ORG] : [CURRENT_ORG, ...OTHER_ORGS]}>
          {state !== "closed" ? <OpenOrgMenu /> : null}
          <div className="column">
            <StateBlock
              state={{
                title: "Org home is not in this design",
                text: "This page stands for org home, where an org pick and a new org land. The design draws the top bar's org menu over it.",
                actions: [{ kind: "link", label: "Open Members", href: "/members", variant: "primary" }],
                reference: null,
              }}
            />
          </div>
        </OrgFrame>
      )}
    </StatePage>
  );
}

// ── New org ────────────────────────────────────────────────────────────────────────────────────

type NewOrgState = (typeof NEW_ORG_STATES.list)[number]["key"];
const NEW_ORG_DRAFT: Record<NewOrgState, string> = {
  ready: "",
  empty: "",
  taken: OTHER_ORGS[0].name,
  creating: "Acme Studio",
  failed: "Acme Studio",
};

export function NewOrgRoute() {
  return (
    <StatePage states={NEW_ORG_STATES}>
      {(state: NewOrgState) => (
        <OrgFrame orgs={[CURRENT_ORG, ...OTHER_ORGS]}>
          <NewOrgForm
            key={state}
            create={designCreate}
            current={RECORDING.shell.org.name}
            phase={state}
            draft={NEW_ORG_DRAFT[state]}
          />
        </OrgFrame>
      )}
    </StatePage>
  );
}

// ── Members ────────────────────────────────────────────────────────────────────────────────────

type MembersState = (typeof MEMBERS_STATES.list)[number]["key"];

interface MembersSetup {
  role: OrgRole;
  members: MemberRow[];
  invites: InviteRow[];
  phase: InvitePhase;
  draft: string;
  toast?: string;
}

function membersSetup(state: MembersState): MembersSetup {
  const base: MembersSetup = { role: "owner", members: MEMBERS_MANY, invites: INVITES_MANY, phase: "list", draft: "" };
  switch (state) {
    case "members":
      return base;
    case "owner-only":
      return { ...base, members: [OWNER], invites: [] };
    case "open":
      return { ...base, phase: "open" };
    case "sending":
      return { ...base, phase: "sending", draft: NEW_ADDRESS };
    case "sent":
      return {
        ...base,
        invites: [sentInvite(NEW_ADDRESS), ...INVITES_MANY],
        toast: MEMBERS_WORDS.invites.sent(NEW_ADDRESS),
      };
    case "not-address":
      return { ...base, phase: "address", draft: NOT_AN_ADDRESS };
    case "already-member":
      return { ...base, phase: "member", draft: MEMBERS_MANY[1].email };
    case "already-invited":
      return { ...base, phase: "invited", draft: INVITES_MANY[0].email };
    case "send-failed":
      return { ...base, phase: "failed", draft: NEW_ADDRESS };
    case "member-view":
      return { ...base, role: "member", invites: [] };
  }
}

export function MembersRoute() {
  return (
    <StatePage states={MEMBERS_STATES}>
      {(state: MembersState) => {
        const s = membersSetup(state);
        // A member's view is drawn as the second member signed in; the owner's as the account.
        const me = s.role === "owner" ? { email: ME, role: s.role } : { email: MEMBERS_MANY[1].email, role: s.role };
        return (
          <OrgFrame orgs={[CURRENT_ORG, ...OTHER_ORGS]}>
            {s.toast ? <Toast text={s.toast} /> : null}
            <MembersView
              key={state}
              org={RECORDING.shell.org.name}
              me={me}
              members={s.members}
              invites={s.invites}
              invite={designInvite(s.members, s.invites)}
              revoke={designRevoke}
              promote={designPromote}
              remove={designRemove}
              leave={designLeave}
              format={FORMAT}
              phase={s.phase}
              draft={s.draft}
            />
          </OrgFrame>
        );
      }}
    </StatePage>
  );
}

// ── The invite link ────────────────────────────────────────────────────────────────────────────

type InviteState = (typeof INVITE_STATES.list)[number]["key"];

const ACCOUNT: Record<InviteState, string | null> = {
  out: null,
  ready: INVITE_VIEW.email,
  joining: INVITE_VIEW.email,
  failed: INVITE_VIEW.email,
  other: OTHER_ACCOUNT,
  member: INVITE_VIEW.email,
  expired: null,
};

export function InviteRoute() {
  return (
    <StatePage states={INVITE_STATES}>
      {(state: InviteState) => (
        <InviteColumn
          key={state}
          initial={{ ...INVITE_VIEW, phase: state as InvitePagePhase, account: ACCOUNT[state] }}
          join={designJoin}
          orgRoute={ORG_ROUTE}
        />
      )}
    </StatePage>
  );
}
