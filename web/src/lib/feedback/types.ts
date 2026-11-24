// The Feedback module's shapes for the session-scoped `/app/feedback*` JSON
// (`server/feedback_api.py`). Pure types, no runtime values.

/**
 * One feedback record as `GET /app/feedback` lists it. Every free-text field is
 * caller-supplied and untrusted: render it as a text child, never as HTML or into
 * an `href`. `project_id` is nullable because the serializer allows it; the list
 * and detail routes only ever return records inside one of the org's projects.
 */
export interface Feedback {
  id: string;
  /** The end user's feedback text. Always present. */
  message: string;
  source_product: string;
  /** The explicit rating: `1` liked, `2` disliked, `null` unrated (the common case). */
  feedback_value: 1 | 2 | null;
  comment: string | null;
  channel: string | null;
  source_integration: string | null;
  /** Who recorded it: `"agent"`, `"human"` or `null` (unspecified). */
  recorded_by: string | null;
  conversation_id: string | null;
  session_id: string | null;
  user_id: string | null;
  trigger_type: string | null;
  trigger_message: string | null;
  /** Free-form caller JSON; no schema. */
  trigger_metadata: Record<string, unknown>;
  target_type: string | null;
  target_id: string | null;
  target_role: string | null;
  target_text: string | null;
  /** When the feedback happened (caller-reported, optional). */
  event_at: string | null;
  /** When it was stored: the list's sort key (newest first). */
  ingested_at: string;
  tags: string[];
  messages: unknown[];
  used_context: unknown[];
  source_metadata: Record<string, unknown>;
  attributes: Record<string, unknown>;
  project_id: string | null;
}

/** An operator comment on a record. Read-only in the web app. */
export interface FeedbackComment {
  id: string;
  /** `null` when the comment was left unattributed. */
  author: string | null;
  body: string;
  created_at: string;
}

/** An uploaded file's metadata, never its bytes. */
export interface FeedbackAttachment {
  id: string;
  /** Whatever the uploader declared: untrusted. */
  content_type: string;
  byte_size: number;
  filename: string | null;
  created_at: string;
  /**
   * An API-relative path that needs the session bearer, so it is never rendered
   * into an `href`: the page links to the web app's own relay instead.
   */
  url: string;
}

/** `GET /app/feedback/{id}` → `{record}`: the record plus its comments and files. */
export interface FeedbackDetail extends Feedback {
  comments: FeedbackComment[];
  attachments: FeedbackAttachment[];
}

/**
 * One numbered page of `GET /app/feedback?page=N` (page 1 without `page`). `total` counts the
 * whole list as read (every filter and the search applied, the same on every page).
 */
export interface FeedbackNumberedPage {
  records: Feedback[];
  total: number;
}

/**
 * The `GET /app/feedback` query, in the API's own names. Every param is optional.
 */
export interface FeedbackQuery {
  /** Case-insensitive substring over message, comment, target text and trigger message. */
  q?: string;
  /** One of the org's projects; another org's is a 404. */
  project_id?: string;
  start_ingested_at?: string;
  end_ingested_at?: string;
  source_product?: string;
  source_integration?: string;
  conversation_id?: string;
  session_id?: string;
  user_id?: string;
  /** 1 liked, 2 disliked; anything else is a 400. */
  feedback_value?: 1 | 2;
  channel?: string;
  recorded_by?: "agent" | "human";
  target_type?: "message" | "conversation" | "surface";
  trigger_type?:
    "like" | "dislike" | "comment" | "rating" | "survey" | "manual" | "other";
  /** A blank tag is a 400, so blanks are never sent. */
  tag?: string;
  /** 1..100, default 50. */
  limit?: number;
  /** A numbered page, 1-based, `limit` a page; page 1 when absent. */
  page?: number;
}

/**
 * `GET /app/feedback/{id}/agenda`: the agenda items a piece of feedback is on (P61-e9), derived by
 * the server from the entries, stored or still pending, whose source is `feedback:<id>` (never
 * stored on the feedback). `linked` false, with no items, when its project has no linked workspace.
 */
export interface FeedbackAgenda {
  /** The feedback's project id, or `null` when it is in none. */
  project: string | null;
  linked: boolean;
  /** In the Agenda's order, each as the Agenda shows it now (a pending add included). */
  items: FeedbackAgendaItem[];
}

export interface FeedbackAgendaItem {
  /** The full agenda id (`A13-n1`). */
  id: string;
  title: string | null;
  lang: "en" | "ko";
  /** The Workspace's agenda state (`ItemState`): `proposed`, `open`, `in_progress`, … */
  state: string | null;
  /** `waiting` until the workspace takes the change, a refusal, or `null`. */
  sync: null | "waiting" | { refused: string; entry: string; kind?: string };
}

/**
 * `POST /app/feedback/{id}/agenda {item?}` → 201: the item the feedback was filed on (a new one
 * minted, or the one named) and the inbox entries written (an add and an entry, or the entry alone).
 */
export interface FeedbackFiled {
  item: string;
  entries: {
    id: string;
    kind: string;
    items: string[];
    fields: Record<string, unknown>;
    minted_id: string | null;
    state: "pending" | "applied" | "refused" | "discarded";
    reason: string | null;
    created_at: string;
  }[];
}
