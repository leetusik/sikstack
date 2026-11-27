"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { ORG_NAME } from "@/content/org";
import {
  BlockText,
  Button,
  buttonClass,
  Cluster,
  Field,
  FieldError,
  Label,
  Notice,
  Panel,
  PanelBody,
  PanelHead,
} from "@/sikstack/ui";
import { checkOrgName } from "@/sikstack/org/model";

/** What the rename answers: the stored name, or why not. */
export type RenameOrgResult =
  | { ok: true; name: string }
  | { ok: false; reason: "empty" | "taken" | "failed" };

type Phase = "rest" | "change" | "saving" | "empty" | "taken" | "failed";

export interface NamePanelProps {
  name: string;
  save: (name: string) => Promise<RenameOrgResult>;
}

/**
 * Org name (F15's rename, P78-s2.S4), an owner's only: the Public URL panel's in-place pattern (`url-panel.tsx`).
 * At rest the name in the body and Change in the head; Change opens the form over the name (Name, Cancel, Save).
 * An empty name is the field's error before any send; a name another of the account's orgs has is the API's
 * `taken`, shown the same way (New org's words); a send with no answer is the notice over the field. Saving: the
 * button's label swaps at its width and the field is disabled. Saved: the panel rests on the new name, and the page's
 * heading, the bar's crumb and the org menu follow (the action revalidates the app's layout).
 */
export function NamePanel({ name, save }: NamePanelProps) {
  const uid = useId();
  const [shown, setShown] = useState(name);
  const [phase, setPhase] = useState<Phase>("rest");
  const [draft, setDraft] = useState("");
  const changeRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const focus = useRef<"name" | "change" | null>(null);

  const [seen, setSeen] = useState(name);
  // A new name from the server (this save's revalidation, or another tab's rename) is the one shown.
  if (name !== seen) {
    setSeen(name);
    setShown(name);
  }

  useEffect(() => {
    if (focus.current === "name") nameRef.current?.focus();
    if (focus.current === "change") changeRef.current?.focus();
    focus.current = null;
  }, [phase]);

  const busy = phase === "saving";
  const error =
    phase === "empty"
      ? ORG_NAME.errors.empty
      : phase === "taken"
        ? ORG_NAME.errors.taken(draft.trim())
        : null;
  const ids = { name: `${uid}-name`, error: `${uid}-error`, notice: `${uid}-notice` };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (!checkOrgName(draft)) {
      focus.current = "name";
      setPhase("empty");
      return;
    }
    if (draft.trim() === shown) {
      focus.current = "change";
      setPhase("rest");
      return;
    }
    setPhase("saving");
    let result: RenameOrgResult;
    try {
      result = await save(draft.trim());
    } catch {
      result = { ok: false, reason: "failed" };
    }
    if (result.ok) {
      setShown(result.name);
      focus.current = "change";
      setPhase("rest");
      return;
    }
    focus.current = "name";
    setPhase(result.reason);
  };

  return (
    <Panel aria-label={ORG_NAME.heading}>
      <PanelHead>
        <h2>{ORG_NAME.heading}</h2>
        {phase === "rest" ? (
          <Cluster>
            <button
              ref={changeRef}
              type="button"
              className={buttonClass()}
              onClick={() => {
                focus.current = "name";
                setDraft(shown);
                setPhase("change");
              }}
            >
              {ORG_NAME.change}
            </button>
          </Cluster>
        ) : null}
      </PanelHead>
      {phase === "rest" ? (
        <PanelBody rule>
          <BlockText>
            <span className="strong" style={{ overflowWrap: "anywhere" }}>
              {shown}
            </span>
          </BlockText>
        </PanelBody>
      ) : (
        <form className="panel-body has-rule stack gap-2" noValidate onSubmit={(e) => void submit(e)}>
          {phase === "failed" ? (
            <Notice danger role="alert" id={ids.notice}>
              {ORG_NAME.saveFailed}
            </Notice>
          ) : null}
          <Field>
            <Label htmlFor={ids.name}>{ORG_NAME.label}</Label>
            <div className="form-row" style={{ alignItems: "flex-start" }}>
              <Field>
                <input
                  ref={nameRef}
                  className="input"
                  id={ids.name}
                  type="text"
                  name="name"
                  autoComplete="organization"
                  value={draft}
                  disabled={busy}
                  aria-invalid={error ? "true" : undefined}
                  aria-describedby={error ? ids.error : phase === "failed" ? ids.notice : undefined}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    if (phase === "empty" || phase === "taken") setPhase("change");
                  }}
                />
                {error ? (
                  <FieldError role="alert" id={ids.error}>
                    {error}
                  </FieldError>
                ) : null}
              </Field>
              <Cluster style={{ marginLeft: "auto" }}>
                <Button
                  disabled={busy}
                  onClick={() => {
                    focus.current = "change";
                    setPhase("rest");
                  }}
                >
                  {ORG_NAME.cancel}
                </Button>
                <Button type="submit" busy={busy} busyLabel={ORG_NAME.saving}>
                  {ORG_NAME.save}
                </Button>
              </Cluster>
            </div>
          </Field>
        </form>
      )}
    </Panel>
  );
}
