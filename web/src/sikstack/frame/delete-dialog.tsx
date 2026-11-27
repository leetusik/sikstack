"use client";

import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Dialog, DialogActions } from "@/sikstack/frame/dialog";
import { Button, Field, FieldError, Label, Notice } from "@/sikstack/ui";

// P88-ms.S3's signed design, applied by P88-ms.S4: the confirm Org settings and Project settings open to delete
// (`src/sikstack/org/settings.tsx`, `src/sikstack/project/settings.tsx`).
import { SETTINGS } from "@/content/settings";

const C = SETTINGS.confirm;

/** Why a delete was refused (`DELETE /app/projects/{id}`, `DELETE /app/tenant`, each a 409 with this `reason`). */
export type DeleteRefusal = "tenant_one" | "install_feedback" | "tracked_path";

/** What a delete answers: done (the page moves on), the typed name refused (409 `name`), a refusal, or no answer. */
export type DeleteResult = { ok: true } | { ok: false; reason: "name" | DeleteRefusal | "failed" };

/** The dialog's phase: typing, the send under way, the API's answers that keep it open. */
export type DeletePhase = "typing" | "deleting" | "failed" | "name" | DeleteRefusal;

/** The typed name matches: the item's exact name, outer spaces aside (as `server/deletion.py`'s `typed_name_matches`). */
export function typedNameMatches(typed: string, name: string): boolean {
  return typed.trim() === name.trim();
}

/**
 * The typed text can no longer become the name by typing on: not empty, and not the start of the name (case counts).
 * Only then does the field say so, so a name half typed is never an error.
 */
export function typedNameWrong(typed: string, name: string): boolean {
  const t = typed.trimStart();
  return t.trim() !== "" && !name.trim().startsWith(t) && !typedNameMatches(typed, name);
}

export interface DeleteDialogProps {
  /** The org's or the project's name: the title's, and the one to type. */
  name: string;
  /** What goes with it, one sentence. */
  text: ReactNode;
  /** The danger button's words: Delete org, Delete project. */
  confirm: string;
  /** The delete itself; on `ok` the parent moves on (`onDeleted`). */
  remove: (typed: string) => Promise<DeleteResult>;
  onDeleted: () => void;
  onClose: () => void;
  /** The refusal's words, by reason (the org's and the project's differ). */
  refusal: (reason: DeleteRefusal) => string;
  /** The first phase and typed text (the design's states; the page opens it empty). */
  phase?: DeletePhase;
  typed?: string;
}

/**
 * The delete confirm (P88-ms.S3's design), the key-revoke confirm's pattern (`keys.tsx`) with the name typed again:
 * the title names the thing (`Delete <name>?`), one sentence says what goes with it, then the field (`Type <name> to
 * confirm`), and Cancel and the danger button at the end. The danger button is ready only while the typed name
 * matches; a typed name that can no longer match is the field's error (`Type <name> exactly as shown.`), as is the
 * API's `name`. Deleting: the button says Deleting… at its width, the field and Cancel wait, Escape does nothing.
 * A send with no answer is the danger notice over the field, the button ready again. A refusal (`tenant_one`,
 * `install_feedback`, `tracked_path`) is the notice with its reason, and the button stays off: no retry can pass.
 * Focus goes to the field first (the one thing to do), and back to the opener on close.
 */
export function DeleteDialog({
  name,
  text,
  confirm,
  remove,
  onDeleted,
  onClose,
  refusal,
  phase: initialPhase = "typing",
  typed: initialTyped = "",
}: DeleteDialogProps) {
  const uid = useId();
  const [phase, setPhase] = useState<DeletePhase>(initialPhase);
  const [typed, setTyped] = useState(initialTyped);
  const fieldRef = useRef<HTMLInputElement>(null);

  const busy = phase === "deleting";
  const refused = phase === "tenant_one" || phase === "install_feedback" || phase === "tracked_path";
  const matches = typedNameMatches(typed, name);
  const wrong = phase === "name" || typedNameWrong(typed, name);
  const ids = { field: `${uid}-name`, error: `${uid}-error`, notice: `${uid}-notice` };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || refused || !matches) return;
    setPhase("deleting");
    let result: DeleteResult;
    try {
      result = await remove(typed.trim());
    } catch {
      result = { ok: false, reason: "failed" };
    }
    if (result.ok) {
      onDeleted();
      return;
    }
    setPhase(result.reason);
    if (result.reason === "name") fieldRef.current?.focus();
  };

  const notice = phase === "failed" ? C.failed(name) : refused ? refusal(phase) : null;

  return (
    <Dialog label={C.title(name)} initialFocus={fieldRef} locked={busy} onClose={onClose}>
      <h2 style={{ overflowWrap: "anywhere" }}>{C.title(name)}</h2>
      <p>{text}</p>
      <form className="stack gap-4" noValidate onSubmit={(e) => void submit(e)}>
        {notice ? (
          <Notice danger role="alert" id={ids.notice}>
            {notice}
          </Notice>
        ) : null}
        <Field>
          <Label htmlFor={ids.field}>
            {C.typeBefore}
            {/* The name in mono: where a name of several words starts and ends is plain, and it reads as what to type. */}
            <span className="mono" style={{ overflowWrap: "anywhere" }}>
              {name}
            </span>
            {C.typeAfter}
          </Label>
          <input
            ref={fieldRef}
            className="input"
            id={ids.field}
            type="text"
            name="name"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={typed}
            disabled={busy}
            aria-invalid={wrong ? "true" : undefined}
            aria-describedby={wrong ? ids.error : notice ? ids.notice : undefined}
            onChange={(e) => {
              setTyped(e.target.value);
              if (phase === "name" || phase === "failed") setPhase("typing");
            }}
          />
          {wrong ? (
            <FieldError role="alert" id={ids.error}>
              {C.wrong(name)}
            </FieldError>
          ) : null}
        </Field>
        <DialogActions>
          <Button disabled={busy} onClick={onClose}>
            {C.cancel}
          </Button>
          <Button
            type="submit"
            variant="danger"
            disabled={!busy && (refused || !matches)}
            busy={busy}
            busyLabel={C.deleting}
          >
            {confirm}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
