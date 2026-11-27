"use client";

import { useRouter } from "next/navigation";

import type { FormatOptions } from "@/lib/format";
import type { KeyRow, MintInput } from "@/sikstack/frame";
import { landAfterDelete } from "@/sikstack/frame/delete-landing";
import { ProjectSettingsView } from "@/sikstack/project/settings";

import { mintCredentialAction, revokeCredentialAction, setProjectVisibilityAction } from "../actions";
import { mintOutcome, revokeOutcome, visibilityOutcome, type Visibility } from "../model";
import { deleteProjectAction } from "./actions";

/**
 * Project settings' client part: the project's kept server actions (`../actions.ts`: the visibility switch project
 * home's head had, and the keys' mint and revoke `ProjectKeys` had) wired to `ProjectSettingsView` with the project's
 * id, the delete (`deleteProjectAction`), and the landing a delete needs (`landAfterDelete`: the toast, then org home).
 */
export function ProjectSettings({
  project,
  org,
  owner,
  keys,
  format,
}: {
  project: { id: string; name: string; visibility: Visibility };
  org: string;
  owner: boolean;
  keys: readonly KeyRow[];
  format: FormatOptions;
}) {
  const router = useRouter();
  const setVisibility = async (next: Visibility) => {
    const form = new FormData();
    form.set("projectId", project.id);
    form.set("visibility", next);
    return { ok: visibilityOutcome(await setProjectVisibilityAction({ error: null }, form)) === "saved" };
  };
  const mint = async ({ name, access }: MintInput) => {
    const form = new FormData();
    form.set("projectId", project.id);
    if (name !== null) form.set("name", name);
    form.set("scope", access);
    return mintOutcome(await mintCredentialAction({ error: null }, form));
  };
  const revoke = async (id: string) => {
    const form = new FormData();
    form.set("projectId", project.id);
    form.set("credentialId", id);
    return revokeOutcome(await revokeCredentialAction({ error: null }, form));
  };
  return (
    <ProjectSettingsView
      project={project}
      org={org}
      owner={owner}
      keys={keys}
      setVisibility={setVisibility}
      mint={mint}
      revoke={revoke}
      deleteProject={(typed) => deleteProjectAction(project.id, typed)}
      onDeleted={() => landAfterDelete(router, project.name)}
      format={format}
    />
  );
}
