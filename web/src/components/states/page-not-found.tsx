import { AppShell } from "@/components/app-shell";
import { notFoundState, StateBlock } from "@/sikstack/states";
import { UiRoot } from "@/sikstack/ui";
import { optionalIdentity } from "@/lib/auth-guards";

/**
 * Page not found, with its frame (job 01 round 03-instrument, Shared states: Not found): the root not-found's, and
 * (P78, F12) any address with no `@` that a public route caught (`/nope`, `/nope/page`), which is no public library
 * or project but a page that does not exist.
 *
 * - Signed in: the Shell stays, as on every signed-in page, and the block reads "Page not found",
 *   "This page doesn’t exist, or it isn’t part of <org name>." and Back to <org name>; no rail item is
 *   current (the Shell follows the path, and an unknown path is no rail item's).
 * - Signed out: there is no Shell to keep and no org to name, so the same block holds its signed title
 *   and one link to the landing, "Go to sikstack" (the operator's answer to OQ7), inside its own `UiRoot`.
 */
export async function PageNotFound() {
  const context = await optionalIdentity();
  if (context) {
    const { identity } = context;
    const org = identity.tenant ?? identity.tenants[0] ?? null;
    return (
      <AppShell identity={identity} legacy={false}>
        <StateBlock state={notFoundState({ orgName: org?.name ?? "—" })} />
      </AppShell>
    );
  }
  return (
    <UiRoot>
      <div className="page">
        <div className="app">
          <main id="main-content" className="app-main">
            <StateBlock state={notFoundState({ orgName: null })} />
          </main>
        </div>
      </div>
    </UiRoot>
  );
}
