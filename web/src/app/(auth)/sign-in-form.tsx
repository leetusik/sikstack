"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type MouseEvent } from "react";

import { FORGOT_COPY, SIGN_IN_COPY, WAITLIST_COPY } from "@/content/auth";
import {
  Button,
  Field,
  FieldError,
  Hint,
  Input,
  Label,
  Notice,
} from "@/sikstack/ui";
import { INVITE } from "@/content/org";
import { publishToast } from "@/sikstack/shell/toast";
import { inviteCodeOf } from "@/sikstack/org/model";
import { isConnectNext } from "@/lib/connect/model";
import { safeNextPath, SIGN_IN_LANDING_PATH } from "@/lib/next-path";

import { useAuthEmail } from "./auth-email";

/**
 * `SignInForm` (job 01 *Sign in*, `SignInForm.dc.html`): the column of `/login` and
 * `/signup` — the title, the panel holding the form, and the line with the link to the
 * other screen — inside `.signin-col`.
 *
 * - `phase` is the board's: `idle | sending | error | done`; `error` is
 *   `wrong | invalid | limited | failed | taken`, keyed by the BFF's status.
 * - A notice stays until the next answer: typing does not clear it, and while the form
 *   is sent again the fields lose their marks and the notice stays. The one field error
 *   (an email already in use) leaves when Email is edited (frame.md F22).
 * - A failing answer clears the password; a send that got no answer keeps it.
 * - Sending (and done, until the next page opens): the button's label swaps at the same
 *   width with `aria-busy`, both fields are disabled, and a second press does nothing.
 * - The email is carried to the other screen by `useAuthEmail` (never in the URL);
 *   `next` rides on the link, as before.
 * - The waitlist (operator D2): a `200 {ok: false, waitlisted: true}` from the BFF shows
 *   the waitlist state in place of the form, in the same column: the title, then
 *   a panel holding one `.block` (the Empty block of `Block.dc.html`, here with no head)
 *   with the sentence and the email used, then the link back to sign in on the link
 *   line. Nothing is stored: a reload shows the form.
 * - Sent from the connect page (`next` is `/connect?code=…`, job 09), a waitlisted answer
 *   goes back there instead: the email and that `next` ride in the `(auth)` layout's memory
 *   (`useAuthEmail().setWaitlisted`), and the connect page shows its own waitlisted state.
 * - Sent from an invite link (`next` is `/invite?code=…`, P78), the form sends the code as `invite`;
 *   an answer that says the code joined the account to its org (`joined`, the org's name) lands on
 *   that org's home with the invite page's toast. Otherwise it returns to the invite, as before.
 * - Sign in has "Forgot password?" on its own line under the link line (P78, F10): `/forgot`, the email typed
 *   carried along by the same layout memory.
 */
export type SignInScreen = "sign-in" | "sign-up";

type Phase = "idle" | "sending" | "error" | "done";
type SignInError = "wrong" | "invalid" | "limited" | "failed" | "taken";

/** The board's status-keyed errors: 401 is sign-in's, 409 sign-up's. */
export function errorFor(
  screen: SignInScreen,
  status: number | null,
): SignInError {
  if (status === 401 && screen === "sign-in") return "wrong";
  if (status === 409 && screen === "sign-up") return "taken";
  if (status === 400 || status === 422) return "invalid";
  if (status === 429) return "limited";
  return "failed";
}

const ENDPOINT: Record<SignInScreen, string> = {
  "sign-in": "/api/auth/login",
  "sign-up": "/api/auth/signup",
};

/** The other screen's address, carrying `next` when it is not the landing (as before). */
function hrefTo(path: string, next: string): string {
  return next === SIGN_IN_LANDING_PATH
    ? path
    : `${path}?next=${encodeURIComponent(next)}`;
}

export function SignInForm({
  screen,
  next: rawNext,
}: {
  screen: SignInScreen;
  /** Already laundered by the page; laundered again here (cheap, fails closed). */
  next?: string;
}) {
  const router = useRouter();
  const next = safeNextPath(rawNext);
  // Sent from an invite link (`next` is `/invite?code=…`), the form sends its code along (P78).
  const invite = inviteCodeOf(next);
  const copy = SIGN_IN_COPY.screens[screen];
  const up = screen === "sign-up";

  const { email, setEmail, setWaitlisted: carryWaitlisted } = useAuthEmail();
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<SignInError | null>(null);
  const [waitlisted, setWaitlisted] = useState<string | null>(null);

  const uid = useId();
  const emailId = `${uid}-email`;
  const passwordId = `${uid}-password`;
  const noticeId = `${uid}-notice`;
  const emailErrId = `${uid}-email-error`;
  const hintId = `${uid}-password-hint`;

  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // The form the focus was in is gone: put it on the state's title.
    if (waitlisted !== null) titleRef.current?.focus();
  }, [waitlisted]);

  const busy = phase === "sending" || phase === "done";
  const marked = phase === "error";
  const both = marked && (error === "wrong" || error === "invalid");
  const taken = error === "taken";
  const notice =
    error === "wrong" || error === "invalid" || error === "limited"
      ? SIGN_IN_COPY.errors[error]
      : error === "failed"
        ? copy.failed
        : null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    // An error stays on screen until the next answer.
    setPhase("sending");
    let res: Response;
    try {
      res = await fetch(ENDPOINT[screen], {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(invite ? { email, password, invite } : { email, password }),
      });
    } catch {
      // No answer: the password is kept.
      setError("failed");
      setPhase("error");
      return;
    }
    let waitlistedAnswer = false;
    let joined: string | null = null;
    try {
      const body = (await res.json()) as { waitlisted?: unknown; joined?: unknown } | null;
      waitlistedAnswer = body?.waitlisted === true;
      joined = typeof body?.joined === "string" ? body.joined : null;
    } catch {
      // a bare status is enough below
    }
    if (res.ok && joined !== null) {
      // The invite's code joined the account to its org (approved, if it waited): the session
      // starts there, and it lands on that org's home, as the invite page's Join does.
      publishToast(INVITE.joined(joined));
      setPhase("done");
      router.replace(SIGN_IN_LANDING_PATH);
      router.refresh();
      return;
    }
    if (res.ok && waitlistedAnswer && isConnectNext(next)) {
      // Back to the connect page, which says the account waits (job 09).
      carryWaitlisted({ email: email.trim(), next });
      setPassword("");
      setPhase("done");
      router.replace(next);
      return;
    }
    if (res.ok && waitlistedAnswer) {
      setWaitlisted(email.trim());
      setPassword("");
      setError(null);
      setPhase("idle");
      return;
    }
    if (res.ok) {
      // The session cookie is set: stay sending until the next page opens.
      setPhase("done");
      router.replace(next);
      router.refresh();
      return;
    }
    setError(errorFor(screen, res.status));
    setPassword("");
    setPhase("error");
  }

  if (waitlisted !== null) {
    const words = WAITLIST_COPY[screen];
    const backToForm = (event: MouseEvent<HTMLAnchorElement>) => {
      // On /login the way back is this screen's own form; on /signup it is /login.
      if (screen === "sign-in") {
        event.preventDefault();
        setWaitlisted(null);
      }
    };
    return (
      <div className="signin-col">
        <div className="stack gap-4">
          <h1 ref={titleRef} tabIndex={-1}>
            {words.title}
          </h1>
          <div className="stack gap-1">
            <div className="panel">
              <div className="panel-body block">
                <p className="block-text signin-wait-text">
                  {words.text(waitlisted)}
                </p>
              </div>
            </div>
            <p className="cluster gap-1">
              <Link
                href={hrefTo(SIGN_IN_COPY.screens["sign-up"].altHref, next)}
                className="link link-row signin-alt"
                onClick={backToForm}
              >
                {WAITLIST_COPY.back}
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
        <h1>{copy.title}</h1>
        <div className="stack gap-1">
          <div className="panel">
            <form
              className="panel-body stack gap-5"
              noValidate
              onSubmit={submit}
            >
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
                    aria-invalid={both || (marked && taken) ? true : undefined}
                    aria-describedby={
                      taken ? emailErrId : both ? noticeId : undefined
                    }
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (taken) {
                        setError(null);
                        setPhase("idle");
                      }
                    }}
                  />
                  {taken && (
                    <FieldError role="alert" id={emailErrId}>
                      {SIGN_IN_COPY.errors.taken}
                    </FieldError>
                  )}
                </Field>
                <Field>
                  <Label htmlFor={passwordId}>{SIGN_IN_COPY.password}</Label>
                  <Input
                    id={passwordId}
                    type="password"
                    name="password"
                    autoComplete={up ? "new-password" : "current-password"}
                    value={password}
                    disabled={busy}
                    aria-invalid={both ? true : undefined}
                    aria-describedby={
                      [both ? noticeId : null, up ? hintId : null]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  {up && <Hint id={hintId}>{SIGN_IN_COPY.passwordHint}</Hint>}
                </Field>
              </div>
              <Button
                type="submit"
                variant="primary"
                className="signin-submit"
                busy={busy}
                busyLabel={copy.submitSending}
              >
                {copy.submit}
              </Button>
            </form>
          </div>
          <p className="cluster gap-1">
            <span className="dim">{copy.altPrompt}</span>
            <Link
              href={hrefTo(copy.altHref, next)}
              className="link link-row signin-alt"
            >
              {copy.altLink}
            </Link>
          </p>
          {up ? null : (
            <p className="cluster gap-1">
              <Link href={FORGOT_COPY.href} className="link link-row signin-alt">
                {FORGOT_COPY.link}
              </Link>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
