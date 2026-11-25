import type { Metadata } from "next";
import { headers } from "next/headers";

import { RESET_COPY } from "@/content/auth";
import { edgeAddress } from "@/lib/knowledge/connect";
import { checkResetCode } from "@/lib/knowledge/password";

import { ResetForm } from "./reset-form";

// `/reset?code=…` (P78, F10): the reset mail's link, in the sign-in frame. Unguarded (a signed-in visitor may reset
// too; the reset ends that account's sessions). Server component: it checks the code with the API first
// (`POST /auth/password/reset/check`, the visitor's address for the API's limit), so a used, expired or unknown link
// — or no code — shows the refused state at once; a refused check (the limit, the API down) is the error page.
export const metadata: Metadata = {
  title: RESET_COPY.title,
};

/** The one code a link carries, else null (a repeated or blank `code` is no code). */
function codeOf(raw: string | string[] | undefined): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim();
  return code && code.length <= 200 ? code : null;
}

export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const code = codeOf((await searchParams).code);
  const state = code ? await checkResetCode(code, edgeAddress(await headers())) : "invalid";
  return <ResetForm code={code ?? ""} initial={state === "valid" ? "form" : "refused"} />;
}
