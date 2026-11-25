"use client";

import { useId, useReducer, useRef } from "react";

import { KEYS, type KeysScope } from "@/content/sikstack-frame";
import { StackLabel, StackTable } from "@/sikstack/feedback/stack-table";
import { date, when, type FormatOptions } from "@/lib/format";
import {
  Button,
  FieldError,
  Notice,
  Panel,
  PanelHead,
  Skeleton,
  Status,
} from "@/sikstack/ui";

import { Copy } from "./copy";
import { Dialog, DialogActions } from "./dialog";
import {
  accessOptions,
  accessWord,
  checkKeyName,
  initialKeysState,
  keyLabel,
  keysReducer,
  KEY_NAME_MAX,
  sendMint,
  shownRows,
  type KeyAccess,
  type KeyRow,
  type MintInput,
  type MintResult,
  type RevokeResult,
} from "./keys-state";

/**
 * Keys (`Keys.dc.html`, frame.md F10, F21): the org's or a project's API keys in one panel. Head with
 * **New key**; the form in place (reach line, Key name with "Optional", Access radios with Full access
 * preset and the capture hint, Cancel and Create key at the end); the table (`.table.is-keys`: Name,
 * Key, Access, Status, Created, Last used, and Revoke at the end of a key that is not revoked); the
 * empty block; the show-once dialog (the key with Copy focused, Done) and the revoke confirm (Cancel
 * focused, Yes, revoke, Revoking…). `loading` is F21's panel: the head with New key disabled, the
 * seven column heads, three skeleton rows.
 *
 * The page passes its own server actions as `mint` and `revoke` and its list as `rows`; after an
 * action the page's list is the truth (a revoked key reads Revoked here at once). The minted key's
 * value lives only in this component's state while its dialog is open, and is dropped when it closes.
 */
export interface KeysProps {
  scope: KeysScope;
  /** Offer the third Access option, Workspace sync (the project page only). */
  workspace?: boolean;
  /** The org's or the project's name, for the form's reach line. */
  subject: string;
  rows: readonly KeyRow[];
  mint: (input: MintInput) => Promise<MintResult>;
  revoke: (id: string) => Promise<RevokeResult>;
  loading?: boolean;
  /** `now` and `timeZone` for Created and Last used (`@/lib/format`); pass `now` from the server. */
  format?: FormatOptions;
  /** The panel's id (org home keeps `org-keys-head` on its head, for the landing's link). */
  headId?: string;
  /**
   * The list alone, for an org member (P78: org keys are the owner's to mint and revoke): no New key, no Revoke.
   */
  readOnly?: boolean;
}

/** The form's radio labels, by scope. */
const ACCESS_LABEL: Record<KeyAccess, string> = {
  full: KEYS.accessFull,
  capture: KEYS.accessCapture,
  workspace: KEYS.accessWorkspace,
};

const STATUS_STATE = {
  active: "active",
  idle: "idle",
  revoked: "revoked",
} as const;

export function Keys({
  scope,
  workspace = false,
  subject,
  rows,
  mint,
  revoke,
  loading = false,
  format,
  headId,
  readOnly = false,
}: KeysProps) {
  const heading = KEYS.heading[scope];
  const uid = useId();
  const [state, dispatch] = useReducer(keysReducer, initialKeysState);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const revokeOpener = useRef<HTMLButtonElement | null>(null);

  if (loading) return <KeysLoading heading={heading} headId={headId} />;

  const list = shownRows(rows, state.revoked);
  const busy = state.phase === "minting";
  const revoking = state.phase === "revoking";
  const formOpen = state.phase === "mint" || busy;
  const target = list.find((r) => r.id === state.target) ?? null;
  const ids = {
    name: `${uid}-name`,
    nameHint: `${uid}-name-hint`,
    nameError: `${uid}-name-error`,
    accessHint: `${uid}-access-hint`,
    radio: `${uid}-access`,
  };

  const closeForm = () => {
    dispatch({ type: "cancel-form" });
    triggerRef.current?.focus();
  };

  const submit = async () => {
    if (state.phase !== "mint") return;
    if (!checkKeyName(state.draft).ok) {
      dispatch({ type: "name-invalid" });
      return;
    }
    dispatch({ type: "mint-start" });
    dispatch(await sendMint(state.draft, state.access, mint));
  };

  const confirmRevoke = async () => {
    if (state.phase !== "confirm" || !target) return;
    const id = target.id;
    dispatch({ type: "revoke-start" });
    let ok = false;
    try {
      ok = (await revoke(id)).ok;
    } catch {
      ok = false;
    }
    dispatch(ok ? { type: "revoke-ok", id } : { type: "revoke-failed" });
  };

  return (
    <Panel aria-label={heading}>
      <PanelHead>
        <h2 id={headId}>{heading}</h2>
        {readOnly ? null : (
          <Button
            ref={triggerRef}
            aria-expanded={formOpen}
            disabled={busy}
            onClick={() =>
              state.phase === "mint"
                ? closeForm()
                : dispatch({ type: "toggle-form" })
            }
          >
            {KEYS.newKey}
          </Button>
        )}
      </PanelHead>

      {formOpen && !readOnly ? (
        <form
          className="panel-body has-rule stack"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {state.failed ? (
            <Notice danger role="alert">
              {KEYS.createFailed}
            </Notice>
          ) : null}
          <p className="dim">{KEYS.reach[scope](subject)}</p>
          <div className="form-row">
            <div className="field">
              <label className="label" htmlFor={ids.name}>
                {KEYS.nameLabel}
              </label>
              <input
                className="input"
                id={ids.name}
                type="text"
                maxLength={KEY_NAME_MAX}
                autoComplete="off"
                autoFocus
                placeholder={KEYS.namePlaceholder[scope]}
                aria-invalid={state.nameError ? true : undefined}
                aria-describedby={
                  state.nameError
                    ? `${ids.nameError} ${ids.nameHint}`
                    : ids.nameHint
                }
                value={state.draft}
                disabled={busy}
                onChange={(e) =>
                  dispatch({ type: "set-draft", draft: e.target.value })
                }
              />
              {state.nameError ? (
                <FieldError id={ids.nameError}>{KEYS.nameError}</FieldError>
              ) : null}
              <span className="hint" id={ids.nameHint}>
                {KEYS.nameHint}
              </span>
            </div>
            <fieldset className="field" aria-describedby={ids.accessHint}>
              <legend className="label">{KEYS.accessLegend}</legend>
              <div className="cluster gap-4">
                {accessOptions(workspace).map((access) => (
                  <label className="check" key={access}>
                    <input
                      type="radio"
                      name={ids.radio}
                      checked={state.access === access}
                      disabled={busy}
                      onChange={() => dispatch({ type: "set-access", access })}
                    />
                    {ACCESS_LABEL[access]}
                  </label>
                ))}
              </div>
              <span className="hint" id={ids.accessHint}>
                {workspace
                  ? `${KEYS.accessHint} ${KEYS.accessWorkspaceHint}`
                  : KEYS.accessHint}
              </span>
            </fieldset>
          </div>
          <div className="cluster to-end">
            <Button disabled={busy} onClick={closeForm}>
              {KEYS.cancel}
            </Button>
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              busyLabel={KEYS.creating}
            >
              {KEYS.create}
            </Button>
          </div>
        </form>
      ) : null}

      {list.length > 0 ? (
        // P78, F14: the table stacks under 48em of its width (`StackTable`, as Members does): a row is its name,
        // then the other cells on one line, the dates with their column's name, Revoke at the line's end.
        <StackTable className="is-keys">
          <KeysHead />
          <tbody>
            {list.map((r) => {
              const label = keyLabel(r);
              return (
                <tr key={r.id}>
                  <td className={r.name ? "strong is-main" : "dim is-main"}>
                    {r.name || KEYS.unnamed}
                  </td>
                  <td className="mono nowrap">{r.prefix}…</td>
                  <td className="nowrap">{accessWord(r.access)}</td>
                  <td>
                    <Status state={STATUS_STATE[r.status]}>
                      {KEYS.status[r.status]}
                    </Status>
                  </td>
                  <td className="nowrap">
                    <StackLabel>{KEYS.columns.created}</StackLabel>
                    {date(r.created, format)}
                  </td>
                  <td className="nowrap">
                    <StackLabel>{KEYS.columns.lastUsed}</StackLabel>
                    {when(r.lastUsed, format)}
                  </td>
                  <td className="at-end">
                    {r.status !== "revoked" && !readOnly ? (
                      <Button
                        variant="quiet"
                        aria-label={KEYS.revokeLabel(label)}
                        onClick={(e) => {
                          revokeOpener.current = e.currentTarget;
                          dispatch({ type: "ask-revoke", id: r.id });
                        }}
                      >
                        {KEYS.revoke}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </StackTable>
      ) : (
        <div className="panel-body has-rule block">
          <p className="block-text">{KEYS.empty[scope]}</p>
        </div>
      )}

      {state.phase === "shown" && state.key !== null ? (
        <Dialog
          label={KEYS.shownTitle}
          initialFocus={copyRef}
          returnFocus={() => triggerRef.current}
          onClose={() => dispatch({ type: "close-key" })}
        >
          <h2>{KEYS.shownTitle}</h2>
          <p>{KEYS.shownText}</p>
          <Copy
            text={state.key}
            label={KEYS.copyKey}
            mono
            primary
            buttonRef={copyRef}
          />
          <DialogActions>
            <Button onClick={() => dispatch({ type: "close-key" })}>
              {KEYS.done}
            </Button>
          </DialogActions>
        </Dialog>
      ) : null}

      {(state.phase === "confirm" || revoking) && target ? (
        <Dialog
          label={KEYS.confirmTitle(keyLabel(target))}
          initialFocus={cancelRef}
          locked={revoking}
          returnFocus={() =>
            revokeOpener.current?.isConnected
              ? revokeOpener.current
              : triggerRef.current
          }
          onClose={() => dispatch({ type: "cancel-revoke" })}
        >
          <h2>{KEYS.confirmTitle(keyLabel(target))}</h2>
          <p>{KEYS.confirmText}</p>
          {state.revokeFailed ? (
            <Notice danger role="alert">
              {KEYS.revokeFailed}
            </Notice>
          ) : null}
          <DialogActions>
            <Button
              ref={cancelRef}
              disabled={revoking}
              onClick={() => dispatch({ type: "cancel-revoke" })}
            >
              {KEYS.cancel}
            </Button>
            <Button
              variant="danger"
              busy={revoking}
              busyLabel={KEYS.revoking}
              onClick={() => void confirmRevoke()}
            >
              {KEYS.confirmYes}
            </Button>
          </DialogActions>
        </Dialog>
      ) : null}
    </Panel>
  );
}

function KeysHead() {
  const c = KEYS.columns;
  return (
    <thead>
      <tr>
        <th scope="col">{c.name}</th>
        <th scope="col">{c.key}</th>
        <th scope="col">{c.access}</th>
        <th scope="col">{c.status}</th>
        <th scope="col">{c.created}</th>
        <th scope="col">{c.lastUsed}</th>
        <th scope="col" className="at-end">
          <span className="sr-only">{c.action}</span>
        </th>
      </tr>
    </thead>
  );
}

/** The bar widths of F21's three skeleton rows, cell by cell. */
const SKELETON_ROWS = [
  ["8em", "10ch", "5em", "4em", "3em", "4em"],
  ["5em", "10ch", "5em", "4em", "3em", "4em"],
  ["6em", "10ch", "5em", "4em", "3em", "4em"],
] as const;

const SKELETON_CELLS = ["", "mono nowrap", "nowrap", "", "nowrap", "nowrap"];

function KeysLoading({
  heading,
  headId,
}: {
  heading: string;
  headId?: string;
}) {
  return (
    <Panel aria-label={heading} aria-busy="true">
      <PanelHead>
        <h2 id={headId}>{heading}</h2>
        <Button disabled>{KEYS.newKey}</Button>
      </PanelHead>
      <div className="table-scroll">
        <table className="is-keys table">
          <KeysHead />
          <tbody>
            {SKELETON_ROWS.map((widths, i) => (
              <tr key={i}>
                {widths.map((w, j) => (
                  <td key={j} className={SKELETON_CELLS[j] || undefined}>
                    <Skeleton width={w} />
                  </td>
                ))}
                <td className="at-end" />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <span className="sr-only">{KEYS.loading}</span>
    </Panel>
  );
}
