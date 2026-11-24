import { loginHref } from "@/lib/next-path";
import { openSession, readSessionCookie } from "@/lib/session";
import { retiredJobHref } from "@/lib/workspace/address";
import { readFoldedJob } from "@/lib/workspace/read";

/**
 * P61-e9 — one deferred job's page, retired: a 307 to the agenda item whose fold entry carries the job (the
 * folded-job lookup, `GET …/workspace/deferred/{job}` → `{agenda}`), or to the Agenda when no entry names it (a 404)
 * or the lookup fails. Signed out, the reader signs in and comes back to this address, which then resolves it.
 * Every `Location` is relative, as `/documents` does it.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function temporary(location: string): Response {
  return new Response(null, {
    status: 307,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ projectId: string; job: string }> },
): Promise<Response> {
  const { projectId, job } = await params;
  const token = openSession(readSessionCookie(req));
  if (!token) {
    const url = new URL(req.url);
    return temporary(loginHref(url.pathname));
  }
  let agenda: string | null = null;
  try {
    const read = await readFoldedJob(token, projectId, job);
    if (read.state === "ready" && typeof read.value?.agenda === "string")
      agenda = read.value.agenda;
  } catch {
    // a 401 (the session ended) or an abort: the Agenda's own guard says the rest
    agenda = null;
  }
  return temporary(retiredJobHref(projectId, agenda));
}
