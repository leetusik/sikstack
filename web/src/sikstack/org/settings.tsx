"use client";

import { useState } from "react";

import type { SaveSlugResult } from "@/app/(app)/dashboard/org-home-model";
import { ORG_NAME } from "@/content/org";
import { SETTINGS } from "@/content/settings";
import { plural } from "@/lib/format";
import { DeleteDialog, type DeletePhase, type DeleteResult } from "@/sikstack/frame/delete-dialog";
import { BlockText, Button, Grid, Panel, PanelBody, PanelHead } from "@/sikstack/ui";

// P88-ms.S3's signed design, applied by P88-ms.S4: the page `src/app/(app)/settings/page.tsx` (its client part,
// `org-settings.tsx`) passes the server actions; Org name and Public URL (`name-panel.tsx`, `url-panel.tsx`) came
// here from org home, which no longer draws them.
import { MembersView, type MembersViewProps } from "./members";
import type { OrgRole } from "./model";
import { NamePanel, type RenameOrgResult } from "./name-panel";
import { UrlPanel, UrlReadPanel } from "./url-panel";

export interface OrgSettingsProps
  extends Omit<MembersViewProps, "org" | "me" | "onSteppedDown"> {
  org: { name: string; slug: string | null; projects: number };
  me: { email: string; role: OrgRole };
  rename: (name: string) => Promise<RenameOrgResult>;
  saveSlug: (slug: string) => Promise<SaveSlugResult>;
  /** `DELETE /app/tenant {name}`; on success the page lands on the account's next org's home. */
  deleteOrg: (typed: string) => Promise<DeleteResult>;
  onDeleted: () => void;
  /** The delete dialog open at first, in a phase (the design's states; the page opens with it closed). */
  dialog?: { phase: DeletePhase; typed: string } | null;
}

/** Org name for a member (the rename is the owner's): the name, no Change. */
function NameReadPanel({ name }: { name: string }) {
  return (
    <Panel aria-label={ORG_NAME.heading}>
      <PanelHead>
        <h2>{ORG_NAME.heading}</h2>
      </PanelHead>
      <PanelBody rule>
        <BlockText>
          <span className="strong" style={{ overflowWrap: "anywhere" }}>
            {name}
          </span>
        </BlockText>
      </PanelBody>
    </Panel>
  );
}

/**
 * Org settings (`/settings`, P88-ms.S3's design): the org's own things on one page, in the order they change least
 * to most final. The title (Org settings); Org name and Public URL side by side (one column under 48em: the grid's
 * 24em cells), the panels org home had; Members and Invites (`members.tsx`, the page `/members` was); and, an
 * owner's only, Delete org: one line of what goes, and Delete, which opens the confirm with the name typed again.
 *
 * A member's view: the name read only, the Public URL read only when set (none when not), Members with its own
 * Leave, no Invites and no Delete org. An owner who steps down gets the member's view at once.
 */
export function OrgSettingsView({
  org,
  me,
  rename,
  saveSlug,
  deleteOrg,
  onDeleted,
  dialog = null,
  ...members
}: OrgSettingsProps) {
  const [role, setRole] = useState<OrgRole>(me.role);
  const [name, setName] = useState(org.name);
  const [confirm, setConfirm] = useState(dialog);
  const owner = role === "owner";
  const D = SETTINGS.org.delete;
  const C = SETTINGS.confirm;

  return (
    <div className="column">
      <header className="page-top">
        <div className="page-head">
          <div className="page-title">
            <h1>{SETTINGS.org.title}</h1>
          </div>
        </div>
      </header>

      <Grid min="24em">
        {owner ? (
          <NamePanel
            name={name}
            save={async (next) => {
              const result = await rename(next);
              if (result.ok) setName(result.name);
              return result;
            }}
          />
        ) : (
          <NameReadPanel name={name} />
        )}
        {owner ? <UrlPanel slug={org.slug} save={saveSlug} /> : org.slug ? <UrlReadPanel slug={org.slug} /> : null}
      </Grid>

      <MembersView {...members} org={name} me={{ email: me.email, role }} onSteppedDown={() => setRole("member")} />

      {owner ? (
        <Panel aria-label={D.heading}>
          <PanelHead>
            <h2>{D.heading}</h2>
            <Button
              aria-label={D.openLabel(name)}
              onClick={() => setConfirm({ phase: "typing", typed: "" })}
            >
              {D.open}
            </Button>
          </PanelHead>
          <PanelBody rule>
            <p style={{ overflowWrap: "anywhere" }}>{D.text(name)}</p>
          </PanelBody>
        </Panel>
      ) : null}

      {owner && confirm ? (
        <DeleteDialog
          name={name}
          text={C.orgText(plural(org.projects, "project"), org.projects === 1, plural(members.members.length, "member"))}
          confirm={C.deleteOrg}
          remove={deleteOrg}
          onDeleted={() => {
            setConfirm(null);
            onDeleted();
          }}
          onClose={() => setConfirm(null)}
          refusal={(reason) =>
            reason === "tenant_one"
              ? C.refused.tenant_one(name)
              : reason === "install_feedback"
                ? C.refused.install_feedback(name)
                : C.refused.tracked_path(name)
          }
          phase={confirm.phase}
          typed={confirm.typed}
        />
      ) : null}
    </div>
  );
}
