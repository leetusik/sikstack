import { SETTINGS } from "@/content/settings";
import { publishToast } from "@/sikstack/shell";

/** Where a delete lands: the org's home (the next org's, after an org's delete; the org's own, after a project's). */
export const DELETE_LANDING = "/dashboard";

/** The part of Next's router a landing uses (`useRouter()`'s). */
export interface LandingRouter {
  push: (href: string) => void;
  refresh: () => void;
}

/**
 * After a delete (P88-ms.S3's design: Org settings' and Project settings' confirm): the toast names what went
 * (`<name> deleted.`), and the page moves to org home and reads it again, as New org lands on its org's home. The
 * action has already moved the org cookie (an org's delete), so the home read is the next org's.
 */
export function landAfterDelete(router: LandingRouter, name: string): void {
  publishToast(SETTINGS.confirm.deleted(name));
  router.push(DELETE_LANDING);
  router.refresh();
}
