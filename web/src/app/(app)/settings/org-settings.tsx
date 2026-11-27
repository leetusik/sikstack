"use client";

import { useRouter } from "next/navigation";

import { landAfterDelete } from "@/sikstack/frame/delete-landing";
import { OrgSettingsView, type OrgSettingsProps } from "@/sikstack/org/settings";

/**
 * Org settings' client part: the page's server actions handed to `OrgSettingsView`, and the landing a delete needs
 * (`landAfterDelete`: the toast, then org home, read again in the org the action moved the cookie to).
 */
export function OrgSettings(props: Omit<OrgSettingsProps, "onDeleted" | "dialog">) {
  const router = useRouter();
  return <OrgSettingsView {...props} onDeleted={() => landAfterDelete(router, props.org.name)} />;
}
