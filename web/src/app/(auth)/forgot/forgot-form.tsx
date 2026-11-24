"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import { FORGOT_COPY, SIGN_IN_COPY } from "@/content/auth";
import { Button, Field, Input, Label, Notice } from "@/sikstack/ui";

import { useAuthEmail } from "../auth-email";

/**
 * `/forgot` (P78, F10; the sign-in frame's column, no design round): Email and Send link in the panel, the way back
 * to sign in under it. The email typed on `/login` comes along (`useAuthEmail`, never in the URL). The answer is the
 * same whatever the address (the BFF's `200 {ok: true}`): the column turns into Check your email, naming the address
 * typed. A refusal is the notice over the field: an empty address (before any send), the limit (429), or anything
 * else (Could not send the link).
 */
type Phase = "idle" | "sending" | "error";
type ForgotError = "invalid" | "limited" | "failed";

export function forgotErrorFor(status: number | null): ForgotError {
  if (status === 400 || status === 422) return "invalid";
  if (status === 429) return "limited";
  return "failed";
}

export function ForgotForm() {
  const { email, setEmail } = useAuthEmail();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<ForgotError | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const uid = useId();
  const emailId = `${uid}-email`;
  const noticeId = `${uid}-notice`;
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (sent !== null) titleRef.current?.focus();
  }, [sent]);

  const busy = phase === "sending";
  const notice =
    error === "invalid"
      ? FORGOT_COPY.invalid
      : error === "limited"
        ? SIGN_IN_COPY.errors.limited
        : error === "failed"
          ? FORGOT_COPY.failed
          : null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const address = email.trim();
    if (!address) {
      setError("invalid");
      setPhase("error");
      return;
    }
    setPhase("sending");
    let status: number | null = null;
    try {
      const res = await fetch("/api/auth/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: address }),
      });
      status = res.status;
      if (res.ok) {
        setSent(address);
        setError(null);
        setPhase("idle");
        return;
      }
    } catch {
      // no answer: the notice below
    }
    setError(forgotErrorFor(status));
    setPhase("error");
  }

  if (sent !== null) {
    return (
      <div className="signin-col">
        <div className="stack gap-4">
          <h1 ref={titleRef} tabIndex={-1}>
            {FORGOT_COPY.sentTitle}
          </h1>
          <div className="stack gap-1">
            <div className="panel">
              <div className="panel-body block">
                <p className="block-text signin-wait-text">{FORGOT_COPY.sentText(sent)}</p>
              </div>
            </div>
            <p className="cluster gap-1">
              <Link href="/login" className="link link-row signin-alt">
                {FORGOT_COPY.back}
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
        <h1>{FORGOT_COPY.title}</h1>
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
                  <Label htmlFor={emailId}>{SIGN_IN_COPY.email}</Label>
                  <Input
                    id={emailId}
                    type="email"
                    name="email"
                    autoComplete="email"
                    value={email}
                    disabled={busy}
                    aria-invalid={error === "invalid" ? true : undefined}
                    aria-describedby={notice !== null ? noticeId : undefined}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Field>
              </div>
              <Button
                type="submit"
                variant="primary"
                className="signin-submit"
                busy={busy}
                busyLabel={FORGOT_COPY.submitSending}
              >
                {FORGOT_COPY.submit}
              </Button>
            </form>
          </div>
          <p className="cluster gap-1">
            <Link href="/login" className="link link-row signin-alt">
              {FORGOT_COPY.back}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
