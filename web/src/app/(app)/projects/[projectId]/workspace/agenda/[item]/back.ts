import { WS_PLACES } from "@/content/workspace/frame";
import type { WsBack } from "@/sikstack/workspace/frame";
import { decodeWorkspaceFrom, wayBack } from "@/lib/workspace/address";

/**
 * An agenda's way back (F36, F300): the Agenda (a `?from=` naming another list is ignored); labelled with the
 * destination's own name, never text from the address. Pure, so the page, its loading state and its boundary share
 * it.
 */
export function agendaItemBack(
  project: string,
  from: string | string[] | null | undefined,
): WsBack {
  const way = wayBack(
    project,
    { kind: "agenda-item" },
    decodeWorkspaceFrom(from, project),
  );
  return { href: way.href, label: WS_PLACES.agenda };
}
