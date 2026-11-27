"use client";

import { useRouter } from "next/navigation";

import { DELETE_LANDING, landAfterDelete } from "@/sikstack/frame/delete-landing";
import { OrgSettingsView, type OrgSettingsProps } from "@/sikstack/org/settings";

/**
 * Org settings' client part: the page's server actions handed to `OrgSettingsView`, and the landings the page moves
 * by: after a delete (`landAfterDelete`: the toast, then org home, read again in the org the action moved the cookie
 * to), and after a Leave (org home again, read in the org the cleared cookie falls back to; the action answers
 * `{ok: true}` instead of redirecting, so the Members panel never takes the move for a failure).
 */
export function OrgSettings(props: Omit<OrgSettingsProps, "onDeleted" | "dialog">) {
  const router = useRouter();
  const leave = async () => {
    const result = await props.leave();
    if (result?.ok) {
      router.push(DELETE_LANDING);
      router.refresh();
    }
    return result;
  };
  return (
    <OrgSettingsView {...props} leave={leave} onDeleted={() => landAfterDelete(router, props.org.name)} />
  );
}
