"use client";

import { useEffect, type ReactNode } from "react";

import { SKIP_TO_CONTENT } from "@/content";
import { publishToast, ShellOrgNameProvider, ToastRegion } from "@/sikstack/shell";
import { StateBlock } from "@/sikstack/states";
import { Legacy } from "@/sikstack/ui/boundary";
import { UiRoot } from "@/sikstack/ui/root";

import { InviteColumn } from "@/sikstack/org/invite";
import type { InvitePagePhase, InviteRow, MemberRow, OrgRole } from "@/sikstack/org/model";
import { NewOrgForm } from "@/sikstack/org/new-org";

// The Shell's next version (P88-ms.S3's design: Settings in both rails, the org menu's line for a shared name), drawn
// on every org page here; the Workspace's, Design's and Feedback's pages (`screens.tsx`) keep production's.
import { SETTINGS } from "../next/content/settings";
import type { DeletePhase } from "../next/frame/delete-dialog";
import { stepDownToast } from "../next/org/members";
import { OrgSettingsView } from "../next/org/settings";
import { ProjectSettingsView } from "../next/project/settings";
import type { ShellOrg } from "../next/shell/model";
import { Shell } from "../next/shell/shell";
import { DESIGN_MARK } from "./mark";
import {
  CURRENT_ORG,
  CURRENT_ORG_OWNED,
  designCreate,
  designDelete,
  designInvite,
  designJoin,
  designLeave,
  designMint,
  designPromote,
  designRemove,
  designRename,
  designRevoke,
  designRevokeKey,
  designSaveSlug,
  designSetVisibility,
  designStepDown,
  INVITE_VIEW,
  INVITES_MANY,
  ME,
  MEMBERS_MANY,
  MEMBERS_TWO_OWNERS,
  ORG_SLUG,
  OTHER_ACCOUNT,
  OTHER_ORGS,
  OWNER,
  PROJECT_KEYS,
  SAME_NAME_ORG,
} from "./org-data";
import {
  INVITE_STATES,
  NEW_ORG_STATES,
  ORG_SETTINGS_STATES,
  ORG_SWITCHER_STATES,
  PROJECT_SETTINGS_STATES,
} from "./page-states";
import { NOW, PROJECT, RECORDING, TIME_ZONE } from "./recording";
import { StatePage } from "./states";

/**
 * The org surfaces' screens (P78-s2.S2's design; the settings pages, P88-ms.S3's): the Shell (the org menu for every
 * account, New org at its foot, Settings in the rail) and the org components (`src/sikstack/org/`, and the next
 * versions in `design/next/`), on made data (`org-data.ts`). The page's state widget sets each component's first
 * phase; the components then run as production would, their actions answered in the browser.
 */

const FORMAT = { timeZone: TIME_ZONE, now: NOW };
/** Where an org pick posts in the design (a static build has no route: the Frame's, as the other pages'). */
const ORG_ROUTE = "/org";
const ORG_NAME = RECORDING.shell.org.name;
const PROJECT_NAME = RECORDING.shell.project.name;

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
              <ShellOrgNameProvider name={ORG_NAME}>{children}</ShellOrgNameProvider>
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

const SWITCHER_ORGS: Record<SwitcherState, ShellOrg[]> = {
  several: [CURRENT_ORG, ...OTHER_ORGS],
  // The account's own org and one it joined, both named as the recording's org (P88-ms.S3).
  "same-name": [CURRENT_ORG_OWNED, SAME_NAME_ORG, OTHER_ORGS[0]],
  one: [CURRENT_ORG],
  closed: [CURRENT_ORG, ...OTHER_ORGS],
};

export function OrgSwitcherRoute() {
  return (
    <StatePage states={ORG_SWITCHER_STATES}>
      {(state: SwitcherState) => (
        <OrgFrame key={state} orgs={SWITCHER_ORGS[state]}>
          {state !== "closed" ? <OpenOrgMenu /> : null}
          <div className="column">
            <StateBlock
              state={{
                title: "Org home is not in this design",
                text: "This page stands for org home, where an org pick and a new org land. The design draws the top bar's org menu over it.",
                actions: [{ kind: "link", label: "Open Org settings", href: "/settings/", variant: "primary" }],
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
            current={ORG_NAME}
            phase={state}
            draft={NEW_ORG_DRAFT[state]}
          />
        </OrgFrame>
      )}
    </StatePage>
  );
}

// ── Org settings (`/settings`; `/members` is a part of it) ───────────────────────────────────────

type OrgSettingsState = (typeof ORG_SETTINGS_STATES.list)[number]["key"];

interface OrgSettingsSetup {
  role: OrgRole;
  members: MemberRow[];
  invites: InviteRow[];
  slug: string | null;
  dialog: { phase: DeletePhase; typed: string } | null;
  toast?: string;
}

/** A name typed wrong: the org's name in lower case (the confirm counts case). */
const typedWrong = (name: string) => name.toLowerCase();

function orgSettingsSetup(state: OrgSettingsState): OrgSettingsSetup {
  const base: OrgSettingsSetup = { role: "owner", members: MEMBERS_MANY, invites: INVITES_MANY, slug: null, dialog: null };
  const open = (phase: DeletePhase, typed: string) => ({ ...base, dialog: { phase, typed } });
  switch (state) {
    case "owner":
      return base;
    case "no-invites":
      return { ...base, members: [OWNER], invites: [] };
    case "two-owners":
      return { ...base, members: MEMBERS_TWO_OWNERS, slug: ORG_SLUG };
    case "member":
      return { ...base, role: "member", invites: [], slug: ORG_SLUG };
    case "delete-empty":
      return open("typing", "");
    case "delete-wrong":
      return open("typing", typedWrong(ORG_NAME));
    case "delete-right":
      return open("typing", ORG_NAME);
    case "deleting":
      return open("deleting", ORG_NAME);
    case "delete-failed":
      return open("failed", ORG_NAME);
    case "tenant-one":
      return open("tenant_one", ORG_NAME);
    case "last-owner":
      return {
        ...base,
        members: MEMBERS_TWO_OWNERS,
        slug: ORG_SLUG,
        toast: stepDownToast(ORG_NAME, { ok: false, reason: "last_owner" }),
      };
  }
}

export function OrgSettingsRoute() {
  return (
    <StatePage states={ORG_SETTINGS_STATES}>
      {(state: OrgSettingsState) => {
        const s = orgSettingsSetup(state);
        // A member's view is drawn as the second member signed in; the owner's as the account.
        const me = s.role === "owner" ? { email: ME, role: s.role } : { email: MEMBERS_MANY[1].email, role: s.role };
        return (
          <OrgFrame orgs={[CURRENT_ORG, ...OTHER_ORGS]}>
            {s.toast ? <Toast text={s.toast} /> : null}
            <OrgSettingsView
              key={state}
              org={{ name: ORG_NAME, slug: s.slug, projects: CURRENT_ORG.projects ?? 1 }}
              me={me}
              members={s.members}
              invites={s.invites}
              rename={designRename}
              saveSlug={designSaveSlug}
              invite={designInvite(s.members, s.invites)}
              revoke={designRevoke}
              promote={designPromote}
              remove={designRemove}
              leave={designLeave}
              // The refusal's state answers a second press the same way; the rest step down.
              stepDown={
                state === "last-owner" ? async () => ({ ok: false, reason: "last_owner" as const }) : designStepDown
              }
              deleteOrg={designDelete}
              onDeleted={() => publishToast(SETTINGS.confirm.deleted(ORG_NAME))}
              format={FORMAT}
              dialog={s.dialog}
            />
          </OrgFrame>
        );
      }}
    </StatePage>
  );
}

// ── Project settings (`/projects/<id>/settings`) ─────────────────────────────────────────────────

type ProjectSettingsState = (typeof PROJECT_SETTINGS_STATES.list)[number]["key"];

function projectDialog(state: ProjectSettingsState): { phase: DeletePhase; typed: string } | null {
  switch (state) {
    case "owner":
    case "member":
      return null;
    case "delete-empty":
      return { phase: "typing", typed: "" };
    case "delete-wrong":
      return { phase: "typing", typed: "sample-produkt" };
    case "delete-right":
      return { phase: "typing", typed: PROJECT_NAME };
    case "deleting":
      return { phase: "deleting", typed: PROJECT_NAME };
    case "delete-failed":
      return { phase: "failed", typed: PROJECT_NAME };
    case "install-feedback":
      return { phase: "install_feedback", typed: PROJECT_NAME };
    case "tracked-path":
      return { phase: "tracked_path", typed: PROJECT_NAME };
  }
}

export function ProjectSettingsRoute() {
  return (
    <StatePage states={PROJECT_SETTINGS_STATES}>
      {(state: ProjectSettingsState) => (
        <OrgFrame orgs={[CURRENT_ORG, ...OTHER_ORGS]}>
          <ProjectSettingsView
            key={state}
            project={{ id: PROJECT, name: PROJECT_NAME, visibility: RECORDING.shell.project.visibility }}
            org={ORG_NAME}
            owner={state !== "member"}
            keys={PROJECT_KEYS}
            setVisibility={designSetVisibility}
            mint={designMint}
            revoke={designRevokeKey}
            deleteProject={designDelete}
            onDeleted={() => publishToast(SETTINGS.confirm.deleted(PROJECT_NAME))}
            format={FORMAT}
            dialog={projectDialog(state)}
          />
        </OrgFrame>
      )}
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
