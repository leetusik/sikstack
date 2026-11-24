"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { publishToast } from "@/sikstack/shell";
import {
  Button,
  buttonClass,
  Cluster,
  Field,
  FieldError,
  Label,
  Notice,
  Panel,
} from "@/sikstack/ui";

import { NEW_ORG } from "@/content/org";
import {
  checkOrgName,
  phaseAfterCreate,
  type CreateOrgResult,
  type NewOrgPhase,
} from "./model";

const ORG_HOME = "/dashboard";

export interface NewOrgFormProps {
  /** The page's create action: makes the org with one project, as at sign-up, and sets it as the active org. */
  create: (name: string) => Promise<CreateOrgResult>;
  /** The org the account is in now: Cancel goes back to its home. */
  current: string;
  /** The form's first phase and name (the page opens `ready` and empty). */
  phase?: NewOrgPhase;
  draft?: string;
}

/**
 * New org (`/orgs/new`, P78-s2.S2's design): the page's title and one panel holding the form, the Projects panel's
 * form in place on a page of its own: Name, then Cancel and Create org. An empty name is the field's error before
 * any send; a name the account already has is the API's (`taken`), shown the same way; a send that got no answer
 * is the notice over the field, the name kept. Creating: the button's label swaps at the same width, the field and
 * Cancel are disabled, a second press does nothing. A created org is the active one: the page lands on its home
 * and the toast names it.
 */
export function NewOrgForm({ create, current, phase: initialPhase = "ready", draft: initialDraft = "" }: NewOrgFormProps) {
  const router = useRouter();
  const uid = useId();
  const [phase, setPhase] = useState<NewOrgPhase>(initialPhase);
  const [draft, setDraft] = useState(initialDraft);
  const nameRef = useRef<HTMLInputElement>(null);
  const sending = useRef(false);

  useEffect(() => {
    // An error puts the focus back on the field it is about.
    if (phase === "empty" || phase === "taken" || phase === "failed") nameRef.current?.focus();
  }, [phase]);

  const busy = phase === "creating";
  const error = phase === "empty" ? NEW_ORG.errors.empty : phase === "taken" ? NEW_ORG.errors.taken(draft.trim()) : null;
  const ids = { name: `${uid}-name`, error: `${uid}-error`, notice: `${uid}-notice` };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || sending.current) return;
    if (!checkOrgName(draft)) {
      setPhase("empty");
      return;
    }
    sending.current = true;
    setPhase("creating");
    let result: CreateOrgResult;
    try {
      result = await create(draft.trim());
    } catch {
      result = { ok: false, reason: "failed" };
    }
    sending.current = false;
    const next = phaseAfterCreate(result);
    if (next === null && result.ok) {
      publishToast(NEW_ORG.created(result.name));
      router.push(ORG_HOME);
      router.refresh();
      return;
    }
    setPhase(next ?? "failed");
  };

  return (
    <div className="column">
      <header className="page-top">
        <div className="page-head">
          <div className="page-title">
            <h1>{NEW_ORG.title}</h1>
          </div>
        </div>
      </header>
      <Panel className="org-form">
        <form className="panel-body stack gap-4" noValidate onSubmit={(e) => void submit(e)}>
          {phase === "failed" ? (
            <Notice danger role="alert" id={ids.notice}>
              {NEW_ORG.failed}
            </Notice>
          ) : null}
          <Field>
            <Label htmlFor={ids.name}>{NEW_ORG.nameLabel}</Label>
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
                if (phase === "empty" || phase === "taken") setPhase("ready");
              }}
            />
            {error ? (
              <FieldError role="alert" id={ids.error}>
                {error}
              </FieldError>
            ) : null}
          </Field>
          <Cluster className="to-end">
            {busy ? (
              <Button disabled>{NEW_ORG.cancel}</Button>
            ) : (
              <Link href={ORG_HOME} className={buttonClass()} aria-label={`${NEW_ORG.cancel}, back to ${current}`}>
                {NEW_ORG.cancel}
              </Link>
            )}
            <Button type="submit" variant="primary" busy={busy} busyLabel={NEW_ORG.creating}>
              {NEW_ORG.create}
            </Button>
          </Cluster>
        </form>
      </Panel>
    </div>
  );
}
