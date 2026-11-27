"use client";

import { useEffect, useId, useReducer, useRef, type FormEvent } from "react";

import { ORG_HOME } from "@/content/dashboard";
import { Copy } from "@/sikstack/frame";
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

import {
  initialUrlForm,
  slugError,
  urlForm,
  urlShown,
  type SaveSlugResult,
} from "@/app/(app)/dashboard/org-home-model";

/**
 * Public URL (`OrgHomeUrl.dc.html`): claimed, the address with Copy and Change in the head; no name,
 * the form is the body (the empty sentence, Org slug, Save); Change opens the same form over the name
 * with Cancel and the one-line cost. URL name taken, URL name invalid, Saving…, and the failed send's
 * notice. Its Loading is `UrlLoading`.
 */
export interface UrlPanelProps {
  slug: string | null;
  save: (slug: string) => Promise<SaveSlugResult>;
}

/**
 * Public URL for a member (P78: the slug is the owner's to claim): the claimed address with Copy, no Change and no
 * form. The page shows no panel at all to a member while the org has no address.
 */
export function UrlReadPanel({ slug }: { slug: string }) {
  return (
    <Panel aria-label={U.heading}>
      <PanelHead>
        <h2>{U.heading}</h2>
      </PanelHead>
      <PanelBody rule>
        <Copy text={U.address(slug)} label={U.copyLabel} />
      </PanelBody>
    </Panel>
  );
}

const U = ORG_HOME.url;

export function UrlPanel({ slug, save }: UrlPanelProps) {
  const uid = useId();
  const [state, dispatch] = useReducer(urlForm, slug, initialUrlForm);
  const changeRef = useRef<HTMLButtonElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const focus = useRef<"slug" | "change" | null>(null);

  useEffect(() => {
    dispatch({ type: "sync", slug });
  }, [slug]);

  useEffect(() => {
    if (focus.current === "slug") slugRef.current?.focus();
    if (focus.current === "change") changeRef.current?.focus();
    focus.current = null;
  }, [state]);

  const shown = urlShown(state);
  const busy = state.phase === "saving";
  const changing = !shown && state.slug !== null;
  const error = slugError(state.phase);
  const ids = { slug: `${uid}-slug`, error: `${uid}-error` };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const next = urlForm(state, { type: "submit" });
    focus.current = next.phase === "rest" ? "change" : "slug";
    dispatch({ type: "submit" });
    if (next.phase !== "saving") return;
    let result: SaveSlugResult;
    try {
      result = await save(state.draft.trim());
    } catch {
      result = { ok: false, reason: "failed" };
    }
    focus.current = result.ok ? "change" : "slug";
    dispatch({ type: "answer", result });
  };

  return (
    <Panel aria-label={U.heading}>
      <PanelHead>
        <h2>{U.heading}</h2>
        {shown ? (
          <Cluster>
            <button
              ref={changeRef}
              type="button"
              className={buttonClass()}
              onClick={() => {
                focus.current = "slug";
                dispatch({ type: "change" });
              }}
            >
              {U.change}
            </button>
          </Cluster>
        ) : null}
      </PanelHead>
      {shown && state.slug ? (
        <PanelBody rule>
          <Copy text={U.address(state.slug)} label={U.copyLabel} />
        </PanelBody>
      ) : (
        <form
          className="panel-body has-rule stack gap-2"
          onSubmit={(e) => void submit(e)}
        >
          {state.phase === "save-failed" ? (
            <Notice danger role="alert">
              {U.saveFailed}
            </Notice>
          ) : null}
          {state.slug === null ? <BlockText>{U.empty}</BlockText> : null}
          <Field>
            <Label htmlFor={ids.slug}>{U.label}</Label>
            <div className="form-row" style={{ alignItems: "flex-start" }}>
              <Field>
                <Cluster>
                  <span className="dim" aria-hidden="true">
                    {U.prefix}
                  </span>
                  <input
                    ref={slugRef}
                    className="input"
                    style={{ flex: "1 1 7em", width: "auto", minWidth: 0 }}
                    id={ids.slug}
                    type="text"
                    autoComplete="off"
                    placeholder={U.placeholder}
                    aria-invalid={error ? "true" : undefined}
                    aria-describedby={error ? ids.error : undefined}
                    value={state.draft}
                    disabled={busy}
                    onChange={(e) =>
                      dispatch({ type: "type", value: e.target.value })
                    }
                  />
                </Cluster>
                {error ? <FieldError id={ids.error}>{error}</FieldError> : null}
                {changing ? <p className="hint">{U.changeHint}</p> : null}
              </Field>
              <Cluster style={{ marginLeft: "auto" }}>
                {changing ? (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      focus.current = "change";
                      dispatch({ type: "cancel" });
                    }}
                  >
                    {U.cancel}
                  </Button>
                ) : null}
                <Button type="submit" busy={busy} busyLabel={U.saving}>
                  {U.save}
                </Button>
              </Cluster>
            </div>
          </Field>
        </form>
      )}
    </Panel>
  );
}
