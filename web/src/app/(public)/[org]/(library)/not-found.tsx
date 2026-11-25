import { headers } from "next/headers";

import { notFoundState, StateBlock } from "@/sikstack/states";
import { optionalIdentity } from "@/lib/auth-guards";
import { REQUEST_PATH_HEADER } from "@/lib/next-path";
import { publicOrgOf, signInFrom } from "@/lib/public-library/model";

import { libraryNotFound } from "./parts";

/**
 * Library not found (`PublicLibrary.dc.html`, Not found; frame.md F71; D249-7z), inside the layout's
 * frame: an unknown org, and an org that shows this reader nothing public. A visitor reads the visitor's
 * words and **Sign in**; a signed-in reader the member's words and **Back to Library**, with no rail item
 * current.
 *
 * An address with no `@` (any unknown one-segment address, `/nope`) is no public library but a page that does
 * not exist (P78, F12): the app's Page not found in the same frame, **Back to <org>** signed in and **Go to
 * sikstack** signed out.
 */
export default async function PublicLibraryNotFound() {
  const [ctx, path] = await Promise.all([
    optionalIdentity(),
    headers().then((h) => h.get(REQUEST_PATH_HEADER) ?? "/"),
  ]);
  const segment = path.split(/[?#]/)[0].split("/")[1] ?? "";
  if (publicOrgOf(segment) === null) {
    const org = ctx
      ? (ctx.identity.tenant ?? ctx.identity.tenants[0] ?? null)
      : null;
    return (
      <StateBlock
        state={notFoundState({ orgName: ctx ? (org?.name ?? "—") : null })}
      />
    );
  }
  return (
    <StateBlock
      state={libraryNotFound(
        ctx
          ? { viewer: "member" }
          : { viewer: "visitor", signInHref: signInFrom(path) },
      )}
    />
  );
}
