"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import { FORGOT_COPY, RESET_COPY, SIGN_IN_COPY } from "@/content/auth";
import { Button, Field, Hint, Input, Label, Notice } from "@/sikstack/ui";

import { useAuthEmail } from "../auth-email";

/**
 * `/reset?code=…` (P78, F10; the sign-in frame's column, no design round). `form`: New password (sign-up's hint)
 * and Save password. Saved (the BFF's `200 {ok: true, email}`): Password changed, with Sign in, the account's
 * address carried into its Email (`useAuthEmail`). `refused`: a link that is used, expired or unknown, on arrival
 * (the page's check) or on save (410), with the way to ask again. A short password is the notice before any send;
 * the limit (429) and anything else are notices too, and a failing answer clears the field.
 */
export type ResetView = "form" | "refused";
type Phase = "idle" | "sending" | "error" | "done" | "refused";
type ResetError = "invalid" | "limited" | "failed";

export const MIN_PASSWORD = 8;

export function resetOutcome(status: number | null): ResetError | "refused" {
  if (status === 410) return "refused";
  if (status === 400 || status === 422) return "invalid";
  if (status === 429) return "limited";
  return "failed";
}

export function ResetForm({ code, initial }: { code: string; initial: ResetView }) {
  const { setEmail } = useAuthEmail();
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<Phase>(initial === "refused" ? "refused" : "idle");
  const [error, setError] = useState<ResetError | null>(null);
  const uid = useId();
  const passwordId = `${uid}-password`;
  const hintId = `${uid}-hint`;
  const noticeId = `${uid}-notice`;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const outcome = phase === "done" || phase === "refused";

  useEffect(() => {
    if (outcome) titleRef.current?.focus();
  }, [outcome]);

  const busy = phase === "sending";
  const notice =
    error === "invalid"
      ? RESET_COPY.short
      : error === "limited"
        ? SIGN_IN_COPY.errors.limited
        : error === "failed"
          ? RESET_COPY.failed
          : null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (password.length < MIN_PASSWORD) {
      setError("invalid");
      setPhase("error");
      return;
    }
    setPhase("sending");
    let status: number | null = null;
    try {
      const res = await fetch("/api/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, password }),
      });
      status = res.status;
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { email?: unknown } | null;
        if (typeof body?.email === "string" && body.email) setEmail(body.email);
        setPassword("");
        setError(null);
        setPhase("done");
        return;
      }
    } catch {
      // no answer: the password is kept
      setError("failed");
      setPhase("error");
      return;
    }
    const next = resetOutcome(status);
    setPassword("");
    if (next === "refused") {
      setError(null);
      setPhase("refused");
      return;
    }
    setError(next);
    setPhase("error");
  }

  if (outcome) {
    const done = phase === "done";
    return (
      <div className="signin-col">
        <div className="stack gap-4">
          <h1 ref={titleRef} tabIndex={-1}>
            {done ? RESET_COPY.doneTitle : RESET_COPY.refusedTitle}
          </h1>
          <div className="stack gap-1">
            <div className="panel">
              <div className="panel-body block">
                <p className="block-text">{done ? RESET_COPY.doneText : RESET_COPY.refusedText}</p>
              </div>
            </div>
            <p className="cluster gap-1">
              <Link
                href={done ? "/login" : FORGOT_COPY.href}
                className="link link-row signin-alt"
              >
                {done ? RESET_COPY.signIn : RESET_COPY.again}
              </Link>
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="signin-col">
      <div className="stack gap-4">
        <h1>{RESET_COPY.title}</h1>
        <div className="stack gap-1">
          <div className="panel">
            <form className="panel-body stack gap-5" noValidate onSubmit={submit}>
              <div className="stack gap-4">
                {notice !== null && (
                  <Notice danger role="alert" id={noticeId}>
                    {notice}
                  </Notice>
                )}
                <Field>
                  <Label htmlFor={passwordId}>{RESET_COPY.label}</Label>
                  <Input
                    id={passwordId}
                    type="password"
                    name="password"
                    autoComplete="new-password"
                    value={password}
                    disabled={busy}
                    aria-invalid={error === "invalid" ? true : undefined}
                    aria-describedby={[notice !== null ? noticeId : null, hintId].filter(Boolean).join(" ")}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <Hint id={hintId}>{SIGN_IN_COPY.passwordHint}</Hint>
                </Field>
              </div>
              <Button
                type="submit"
                variant="primary"
                className="signin-submit"
                busy={busy}
                busyLabel={RESET_COPY.submitSending}
              >
                {RESET_COPY.submit}
              </Button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
