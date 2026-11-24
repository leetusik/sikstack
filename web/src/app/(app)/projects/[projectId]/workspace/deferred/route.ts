import { agendaHref } from "@/lib/workspace/address";

/**
 * P61-e9 — the Deferred jobs list, retired: every deferred job is folded onto the agenda, so the old address is a
 * 307 to the Agenda, answered before any page renders. The `Location` is relative, as `/documents` does it (behind
 * the edge `req.url` may carry the internal host); a signed-out reader meets the Agenda's own guard there.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const { projectId } = await params;
  return new Response(null, {
    status: 307,
    headers: { Location: agendaHref(projectId), "Cache-Control": "no-store" },
  });
}
