import type { Feedback } from "@/lib/feedback/types";

import type { FeedbackStateRecord, StateCounts } from "../next/feedback/state/model";
import { FEEDBACK } from "./answers";
import { NOW, PROJECT, RECORDING } from "./recording";

/**
 * The Feedback list's data and the states of the recorded pieces (P91-v3.S3's design). **Made, every state:** the
 * recording was taken before feedback had a stored state (`GET /app/feedback` answers `state` and `counts` since
 * P91-v3.S1), and `design:record` records single pieces only (`--feedback <id>`), never a list. So:
 *
 * - the three recorded pieces (`f1`–`f3`) keep their records as recorded and get a made state from what the
 *   recording says of them: `f1` and `f2` are on the agenda (Filed on the first item they are on), `f3` on none (Open);
 * - five more pieces are made here, with the shape the API answers (`state {state, agenda, reason, by, at}`), in the
 *   recording's project, at times before the recording's clock: Open, Resolved by the workspace's sync, and two
 *   Dropped (one with a reason, one without). A Korean message is data, as TASTE says;
 * - one made operator comment and attachment, for the item page's counted Delete confirm (the recorded pieces have
 *   none);
 * - the people are reserved addresses (`example.com`); the signed-in account is the recording's.
 */

const MIN = 60_000;
const ago = (minutes: number) => new Date(NOW - minutes * MIN).toISOString().replace(/\.\d+Z$/, "Z");

/** The signed-in account, as the state's `by` writes it. */
export const ME_BY = `person:${RECORDING.shell.email}`;
const MINA = "person:mina.park@example.com";
const SYNC = "agent:sikstack";

const FIELDS: Omit<Feedback, "id" | "message" | "feedback_value" | "ingested_at"> = {
  source_product: "sikstack",
  comment: null,
  channel: "web",
  source_integration: "org-home",
  recorded_by: null,
  conversation_id: null,
  session_id: null,
  user_id: null,
  trigger_type: null,
  trigger_message: null,
  trigger_metadata: {},
  target_type: null,
  target_id: null,
  target_role: null,
  target_text: null,
  event_at: null,
  tags: [],
  messages: [],
  used_context: [],
  source_metadata: {},
  attributes: {},
  project_id: PROJECT,
};

const id = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;

function made(n: number, message: string, value: 1 | 2 | null, minutes: number): Feedback {
  return { ...FIELDS, id: id(n), message, feedback_value: value, ingested_at: ago(minutes) };
}

const recorded = (key: string): Feedback => {
  const r = FEEDBACK[key]?.record;
  if (!r) throw new Error(`no recorded feedback ${key}`);
  // The recorded detail, as the list draws it (the list reads none of its comments or attachments).
  const record: Feedback = { ...r };
  return record;
};

const F1 = "00000000-0000-4000-8000-0000000000f1";
const F2 = "00000000-0000-4000-8000-0000000000f2";
const F3 = "00000000-0000-4000-8000-0000000000f3";

const first = (key: string) => FEEDBACK[key]?.agenda.items[0]?.id ?? null;

/** Each recorded piece's made state. */
export const RECORDED_STATES: Record<string, FeedbackStateRecord> = {
  [F1]: { state: "filed", agenda: first(F1), reason: null, by: MINA, at: ago(0.5) },
  [F2]: { state: "filed", agenda: first(F2), reason: null, by: ME_BY, at: ago(0.4) },
  [F3]: { state: "open", agenda: null, reason: null, by: null, at: null },
};

/** A Resolved and a Dropped state for the item page's states (made). */
export const MADE_STATES = {
  resolved: (agenda: string | null): FeedbackStateRecord => ({
    state: "resolved",
    agenda,
    reason: null,
    by: agenda ? SYNC : MINA,
    at: ago(0.2),
  }),
  dropped: { state: "dropped", agenda: null, reason: "Collapsing the Solved part is planned with the Agenda's filters.", by: MINA, at: ago(0.2) } satisfies FeedbackStateRecord,
};

export type ListRecord = Feedback & { state: FeedbackStateRecord };

/** The org's feedback, newest first (as the API sorts it). */
export const LIST_RECORDS: ListRecord[] = [
  { ...recorded(F3), state: RECORDED_STATES[F3] },
  { ...recorded(F2), state: RECORDED_STATES[F2] },
  { ...recorded(F1), state: RECORDED_STATES[F1] },
  { ...made(1, "The export button does nothing on Safari", 2, 95), state: { state: "open", agenda: null, reason: null, by: null, at: null } },
  { ...made(2, "검색 결과에 한국어 문서가 안 나와요. 제목으로 찾으면 나오는데 본문 검색이 안 됩니다.", 2, 60 * 5), state: { state: "open", agenda: null, reason: null, by: null, at: null } },
  { ...made(3, "Love the new reader, but the font is small on my phone", 1, 60 * 26), state: { state: "open", agenda: null, reason: null, by: null, at: null } },
  { ...made(4, "Dark mode loses the link colour in tables", null, 60 * 50), state: { state: "resolved", agenda: "A7-2k", reason: null, by: SYNC, at: ago(60 * 3) } },
  { ...made(5, "Can you add a Windows app?", null, 60 * 72), state: { state: "dropped", agenda: null, reason: "Not this year: the web app works on Windows.", by: MINA, at: ago(60 * 30) } },
  { ...made(6, "test test", null, 60 * 80), state: { state: "dropped", agenda: null, reason: null, by: ME_BY, at: ago(60 * 79) } },
];

/** Each state's count over these records. */
export function countsOf(records: readonly { state: FeedbackStateRecord }[]): StateCounts {
  const counts: StateCounts = { open: 0, filed: 0, resolved: 0, dropped: 0 };
  for (const r of records) counts[r.state.state] += 1;
  return counts;
}

/** The made operator comment and attachment the counted Delete confirm names (the item page's). */
export const MADE_COMMENT = {
  id: "00000000-0000-4000-8000-0000000002c1",
  author: "mina.park@example.com",
  body: "Same ask came in twice this week.",
  created_at: ago(10),
};
export const MADE_FILE = {
  id: "00000000-0000-4000-8000-0000000002d1",
  content_type: "image/png",
  byte_size: 184_320,
  filename: "agenda-long.png",
  created_at: ago(1),
  url: "/app/feedback/00000000-0000-4000-8000-0000000000f3/attachments/00000000-0000-4000-8000-0000000002d1",
};

/** The addresses the list links to that no design page draws (each piece's org-scoped page): stubs in `away.ts`. */
export const LIST_ITEM_PATHS = LIST_RECORDS.map((r) => `/feedback/${r.id}`);
