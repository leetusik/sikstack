"use client";

import { useReducer, useState } from "react";

import { flip, visibilityReducer, visibilityToast, type Visibility } from "@/app/(app)/projects/[projectId]/model";
import { PROJECT_HOME } from "@/content/project";
import { Keys, type KeyRow, type MintInput, type MintResult, type RevokeResult } from "@/sikstack/frame";
import { publishToast } from "@/sikstack/shell";
import { Badge, Button, Notice, Panel, PanelBody, PanelHead } from "@/sikstack/ui";
import type { FormatOptions } from "@/lib/format";

// P88-ms.S3's signed design, applied by P88-ms.S4: the page `src/app/(app)/projects/[projectId]/settings/page.tsx`
// (its client part, `project-settings.tsx`) passes the visibility, mint and revoke actions project home had, and
// the delete. Project home keeps the visibility badge alone.
import { SETTINGS } from "@/content/settings";
import { DeleteDialog, type DeletePhase, type DeleteResult } from "@/sikstack/frame/delete-dialog";

const W = PROJECT_HOME.head;

export interface ProjectSettingsProps {
  project: { id: string; name: string; visibility: Visibility };
  org: string;
  /** The viewer owns the org: the visibility switch and Delete project are the owner's. */
  owner: boolean;
  keys: readonly KeyRow[];
  setVisibility: (next: Visibility) => Promise<{ ok: boolean }>;
  mint: (input: MintInput) => Promise<MintResult>;
  revoke: (id: string) => Promise<RevokeResult>;
  /** `DELETE /app/projects/{id} {name}`; on success the page lands on org home. */
  deleteProject: (typed: string) => Promise<DeleteResult>;
  onDeleted: () => void;
  format: FormatOptions;
  /** The delete dialog open at first, in a phase (the design's states; the page opens with it closed). */
  dialog?: { phase: DeletePhase; typed: string } | null;
}

/**
 * Visibility (project home's head switch, moved here): the badge (what new items start as) and, an owner's, the
 * one button that flips it (Make public, Make private; Saving… at its width), with the note on what it sets. A
 * refusal is the danger notice in the panel, the button ready again; saved, the toast says what it means.
 */
function VisibilityPanel({
  name,
  org,
  visibility,
  owner,
  save,
}: {
  name: string;
  org: string;
  visibility: Visibility;
  owner: boolean;
  save: (next: Visibility) => Promise<{ ok: boolean }>;
}) {
  const [state, dispatch] = useReducer(visibilityReducer, { visibility, phase: "idle" });
  const saving = state.phase === "saving";
  const shown = state.visibility;

  const press = async () => {
    if (saving) return;
    const next = flip(shown);
    dispatch({ type: "press" });
    let ok = false;
    try {
      ok = (await save(next)).ok;
    } catch {
      ok = false;
    }
    dispatch({ type: ok ? "saved" : "refused" });
    if (ok) publishToast(visibilityToast(next, name, org));
  };

  return (
    <Panel aria-label={SETTINGS.project.visibility.heading}>
      <PanelHead>
        <h2>{SETTINGS.project.visibility.heading}</h2>
        {owner ? (
          <Button busy={saving} busyLabel={W.saving} onClick={() => void press()}>
            {shown === "public" ? W.makePrivate : W.makePublic}
          </Button>
        ) : null}
      </PanelHead>
      <PanelBody rule className="stack gap-2">
        {state.phase === "failed" ? (
          <Notice danger role="alert">
            {W.failed}
          </Notice>
        ) : null}
        <div className="cluster gap-3 baseline">
          <Badge>{shown === "public" ? W.badge.public : W.badge.private}</Badge>
          {owner ? <p className="meta">{W.defaultNote}</p> : null}
        </div>
      </PanelBody>
    </Panel>
  );
}

/**
 * Project settings (`/projects/<id>/settings`, P88-ms.S3's design): the project's own things, least to most final.
 * The title (Project settings); Visibility (the head switch project home had); API keys (the frame's `Keys`, as
 * project home has them); and, an owner's only, Delete project: one line of what goes, and Delete, which opens the
 * confirm naming what goes with it, the name typed again.
 *
 * A member's view: the badge alone, the keys (a member mints and revokes project keys), no Delete project.
 */
export function ProjectSettingsView({
  project,
  org,
  owner,
  keys,
  setVisibility,
  mint,
  revoke,
  deleteProject,
  onDeleted,
  format,
  dialog = null,
}: ProjectSettingsProps) {
  const [confirm, setConfirm] = useState(dialog);
  const D = SETTINGS.project.delete;
  const C = SETTINGS.confirm;

  return (
    <div className="column">
      <header className="page-top">
        <div className="page-head">
          <div className="page-title">
            <h1>{SETTINGS.project.title}</h1>
          </div>
        </div>
      </header>

      <VisibilityPanel
        name={project.name}
        org={org}
        visibility={project.visibility}
        owner={owner}
        save={setVisibility}
      />

      <Keys scope="project" workspace subject={project.name} rows={keys} mint={mint} revoke={revoke} format={format} />

      {owner ? (
        <Panel aria-label={D.heading}>
          <PanelHead>
            <h2>{D.heading}</h2>
            <Button
              aria-label={D.openLabel(project.name)}
              onClick={() => setConfirm({ phase: "typing", typed: "" })}
            >
              {D.open}
            </Button>
          </PanelHead>
          <PanelBody rule>
            <p style={{ overflowWrap: "anywhere" }}>{D.text(project.name)}</p>
          </PanelBody>
        </Panel>
      ) : null}

      {owner && confirm ? (
        <DeleteDialog
          name={project.name}
          text={C.projectText}
          confirm={C.deleteProject}
          remove={deleteProject}
          onDeleted={() => {
            setConfirm(null);
            onDeleted();
          }}
          onClose={() => setConfirm(null)}
          refusal={(reason) =>
            reason === "tracked_path"
              ? C.refused.tracked_path(project.name)
              : reason === "install_feedback"
                ? C.refused.install_feedback(project.name)
                : C.refused.tenant_one(org)
          }
          phase={confirm.phase}
          typed={confirm.typed}
        />
      ) : null}
    </div>
  );
}
