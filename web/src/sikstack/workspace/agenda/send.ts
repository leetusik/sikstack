import {
  deleteAgendaItems,
  dropAgendaItems,
  proposeAgendaItems,
  reopenAgendaItems,
  solveAgendaItems,
} from "@/lib/workspace/actions";
import type { WriteAnswer } from "@/lib/workspace/types";

import type { AgendaAct } from "./select";

/**
 * One action on picked rows, as one inbox change for all their ids (F303): Propose, Solve with no outcome (round:Q3),
 * Reopen, Drop with its optional reason, Delete. The ids go as given (`sendOrder`).
 */
export function sendAct(
  project: string,
  kind: AgendaAct,
  items: string[],
  reason = "",
): Promise<WriteAnswer> {
  switch (kind) {
    case "propose":
      return proposeAgendaItems(project, items);
    case "solve":
      return solveAgendaItems(project, items);
    case "reopen":
      return reopenAgendaItems(project, items);
    case "drop":
      return dropAgendaItems(
        project,
        items,
        reason.trim() === "" ? undefined : reason,
      );
    case "delete":
      return deleteAgendaItems(project, items);
  }
}
