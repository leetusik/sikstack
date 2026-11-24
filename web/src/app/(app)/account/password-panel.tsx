"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { ACCOUNT } from "@/content/account";
import { publishToast } from "@/sikstack/shell";
import {
  Button,
  buttonClass,
  Cluster,
  Field,
  FieldError,
  Hint,
  Label,
  Notice,
  Panel,
  PanelHead,
} from "@/sikstack/ui";

import {
  checkPasswordChange,
  phaseAfterChange,
  sendPasswordChange,
  type ChangePasswordResult,
  type PasswordPhase,
} from "./password-model";

const P = ACCOUNT.password;

export interface PasswordPanelProps {
  /** The send; by default the BFF route (`sendPasswordChange`). */
  change?: (current: string, password: string) => Promise<ChangePasswordResult>;
}

/**
 * Password (`/account`, P78, F10; the org home's Org name panel pattern, no design round): at rest the head with
 * Change; Change opens the form in the panel (Current password, New password with sign-up's hint, Cancel, Save). An
 * empty or wrong current password is that field's error; a short new one is its field's; the limit and a send with no
 * answer are the notice over the fields. A failing answer empties both fields. The send is the BFF route
 * `/api/auth/password` (never a server action, whose arguments `next dev` logs). Saving: Save's label swaps at its width and the fields are disabled. Changed:
 * the panel rests, the fields are emptied and the toast says the other sessions are signed out.
 */
export function PasswordPanel({ change = sendPasswordChange }: PasswordPanelProps) {
  const uid = useId();
  const [phase, setPhase] = useState<PasswordPhase>("rest");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const changeRef = useRef<HTMLButtonElement>(null);
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  const focus = useRef<"current" | "next" | "change" | null>(null);

  useEffect(() => {
    if (focus.current === "current") currentRef.current?.focus();
    if (focus.current === "next") nextRef.current?.focus();
    if (focus.current === "change") changeRef.current?.focus();
    focus.current = null;
  }, [phase]);

  const busy = phase === "saving";
  const ids = {
    current: `${uid}-current`,
    currentError: `${uid}-current-error`,
    next: `${uid}-next`,
    nextError: `${uid}-next-error`,
    hint: `${uid}-hint`,
    notice: `${uid}-notice`,
  };
  const notice = phase === "limited" ? P.limited : phase === "failed" ? P.failed : null;

  const rest = () => {
    setCurrent("");
    setNext("");
    focus.current = "change";
    setPhase("rest");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const refused = checkPasswordChange(current, next);
    if (refused) {
      focus.current = refused === "current" ? "current" : "next";
      setPhase(refused);
      return;
    }
    setPhase("saving");
    let result: ChangePasswordResult;
    try {
      result = await change(current, next);
    } catch {
      result = { ok: false, reason: "failed" };
    }
    const after = phaseAfterChange(result);
    if (after === "rest") {
      publishToast(P.changed);
      rest();
      return;
    }
    // A failing answer clears both passwords, as sign-in's does.
    setCurrent("");
    setNext("");
    focus.current = after === "short" ? "next" : "current";
    setPhase(after);
  };

  return (
    <Panel aria-label={P.heading}>
      <PanelHead>
        <h2>{P.heading}</h2>
        {phase === "rest" ? (
          <Cluster>
            <button
              ref={changeRef}
              type="button"
              className={buttonClass()}
              onClick={() => {
                focus.current = "current";
                setPhase("change");
              }}
            >
              {P.change}
            </button>
          </Cluster>
        ) : null}
      </PanelHead>
      {phase === "rest" ? null : (
        <form className="panel-body has-rule stack gap-4" noValidate onSubmit={(e) => void submit(e)}>
          {notice !== null ? (
            <Notice danger role="alert" id={ids.notice}>
              {notice}
            </Notice>
          ) : null}
          <Field>
            <Label htmlFor={ids.current}>{P.current}</Label>
            <input
              ref={currentRef}
              className="input"
              id={ids.current}
              type="password"
              name="current-password"
              autoComplete="current-password"
              value={current}
              disabled={busy}
              aria-invalid={phase === "current" ? "true" : undefined}
              aria-describedby={phase === "current" ? ids.currentError : notice ? ids.notice : undefined}
              onChange={(e) => {
                setCurrent(e.target.value);
                if (phase === "current") setPhase("change");
              }}
            />
            {phase === "current" ? (
              <FieldError role="alert" id={ids.currentError}>
                {P.errors.current}
              </FieldError>
            ) : null}
          </Field>
          <Field>
            <Label htmlFor={ids.next}>{P.next}</Label>
            <input
              ref={nextRef}
              className="input"
              id={ids.next}
              type="password"
              name="new-password"
              autoComplete="new-password"
              value={next}
              disabled={busy}
              aria-invalid={phase === "short" ? "true" : undefined}
              aria-describedby={phase === "short" ? `${ids.nextError} ${ids.hint}` : ids.hint}
              onChange={(e) => {
                setNext(e.target.value);
                if (phase === "short") setPhase("change");
              }}
            />
            {phase === "short" ? (
              <FieldError role="alert" id={ids.nextError}>
                {P.errors.short}
              </FieldError>
            ) : null}
            <Hint id={ids.hint}>{P.hint}</Hint>
          </Field>
          <Cluster className="to-end">
            <Button disabled={busy} onClick={rest}>
              {P.cancel}
            </Button>
            <Button type="submit" variant="primary" busy={busy} busyLabel={P.saving}>
              {P.save}
            </Button>
          </Cluster>
        </form>
      )}
    </Panel>
  );
}
