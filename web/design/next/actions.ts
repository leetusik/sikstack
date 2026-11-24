// The two agenda writes this design adds (P61-e9), as the design's browser store answers them (`lib/actions.ts`).
// Production's `@/lib/workspace/actions` has neither yet: applying the design writes both there, beside the others,
// as server actions with these signatures over `POST /app/projects/{id}/workspace/agenda/changes` (`{kind: "entry",
// items: [AID], fields: {kind: "note", body}}` and `{kind: "accept", items}`), and the next versions then import them
// from `@/lib/workspace/actions`.
export { acceptAgendaItems, noteAgendaItem } from "../lib/actions";
