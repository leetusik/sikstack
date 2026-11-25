"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useReducer,
  useRef,
  useTransition,
  type FormEvent,
} from "react";

import { ORG_HOME } from "@/content/dashboard";
import { StackLabel, StackTable } from "@/sikstack/feedback/stack-table";
import { publishToast } from "@/sikstack/shell";
import {
  Block,
  BlockText,
  Button,
  buttonClass,
  Cluster,
  Field,
  FieldError,
  Label,
  Notice,
  Panel,
  PanelHead,
} from "@/sikstack/ui";
import { plural } from "@/lib/format";

import { ProjectsLoading, ProjectsTableHead } from "./org-home-loading";
import {
  initialProjectsForm,
  projectNameError,
  projectsCapped,
  projectsForm,
  type CreateProjectResult,
  type ProjectRowView,
} from "./org-home-model";

/**
 * Projects (`OrgHomeProjects.dc.html`): the head (title, count, New project), the form in place
 * (Project name, Cancel, Create; Creating…; the name error; the failed send's notice), the table
 * (a project's name opens its home; over ten rows the box is capped), the empty block and the failed
 * block with Try again. A created project is first in the table (the page's list after the action
 * revalidates it) and gets the toast.
 */
export interface ProjectsPanelProps {
  /** `null`: the list did not load. */
  rows: readonly ProjectRowView[] | null;
  create: (name: string) => Promise<CreateProjectResult>;
}

const P = ORG_HOME.projects;

export function ProjectsPanel({ rows, create }: ProjectsPanelProps) {
  const router = useRouter();
  const uid = useId();
  const [state, dispatch] = useReducer(projectsForm, initialProjectsForm);
  const [retrying, startRetry] = useTransition();
  const newRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const focus = useRef<"name" | "new" | null>(null);

  useEffect(() => {
    if (focus.current === "name") nameRef.current?.focus();
    if (focus.current === "new") newRef.current?.focus();
    focus.current = null;
  }, [state]);

  if (retrying) return <ProjectsLoading />;

  if (rows === null) {
    return (
      <Panel aria-label={P.heading}>
        <PanelHead>
          <h2 style={{ flex: "1 0 auto" }}>{P.heading}</h2>
        </PanelHead>
        <Block className="panel-body has-rule">
          <BlockText>{P.failed}</BlockText>
          <Button onClick={() => startRetry(() => router.refresh())}>
            {P.retry}
          </Button>
        </Block>
      </Panel>
    );
  }

  const busy = state.phase === "creating";
  const formOpen = state.phase !== "list";
  const error = projectNameError(state.phase);
  const ids = { name: `${uid}-name`, error: `${uid}-error` };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const next = projectsForm(state, { type: "submit" });
    if (next.phase !== "creating") {
      focus.current = "name";
      dispatch({ type: "submit" });
      return;
    }
    dispatch({ type: "submit" });
    let result: CreateProjectResult;
    try {
      result = await create(state.draft);
    } catch {
      result = { ok: false, reason: "failed" };
    }
    focus.current = result.ok ? "new" : "name";
    dispatch({ type: "answer", result });
    if (result.ok) publishToast(P.created(result.name));
  };

  return (
    <Panel aria-label={P.heading}>
      <PanelHead>
        <h2 style={{ flex: "1 0 auto" }}>{P.heading}</h2>
        <p className="meta">{plural(rows.length, P.unit)}</p>
        <button
          ref={newRef}
          type="button"
          className={buttonClass(
            rows.length === 0 && state.phase === "list" ? "primary" : "default",
          )}
          aria-expanded={formOpen}
          disabled={busy}
          onClick={() => {
            if (state.phase === "list") {
              focus.current = "name";
              dispatch({ type: "open" });
            } else {
              dispatch({ type: "cancel" });
            }
          }}
        >
          {P.newProject}
        </button>
      </PanelHead>
      {formOpen ? (
        <form
          className="panel-body has-rule stack gap-2"
          onSubmit={(e) => void submit(e)}
        >
          {state.phase === "create-failed" ? (
            <Notice danger role="alert">
              {P.createFailed}
            </Notice>
          ) : null}
          <Field>
            <Label htmlFor={ids.name}>{P.nameLabel}</Label>
            <div className="form-row" style={{ alignItems: "flex-start" }}>
              <Field>
                <input
                  ref={nameRef}
                  className="input"
                  id={ids.name}
                  type="text"
                  autoComplete="off"
                  placeholder={P.namePlaceholder}
                  aria-invalid={error ? "true" : undefined}
                  aria-describedby={error ? ids.error : undefined}
                  value={state.draft}
                  disabled={busy}
                  onChange={(e) =>
                    dispatch({ type: "type", value: e.target.value })
                  }
                />
                {error ? <FieldError id={ids.error}>{error}</FieldError> : null}
              </Field>
              <Cluster style={{ marginLeft: "auto" }}>
                <Button
                  disabled={busy}
                  onClick={() => {
                    focus.current = "new";
                    dispatch({ type: "cancel" });
                  }}
                >
                  {P.cancel}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  busy={busy}
                  busyLabel={P.creating}
                >
                  {P.create}
                </Button>
              </Cluster>
            </div>
          </Field>
        </form>
      ) : null}
      {rows.length > 0 ? (
        // P78, F14: the table stacks under 48em of its width, as Members and the Design list do (`StackTable`): a
        // row is its project's link, then its other cells on one line, each count and date with its column's name.
        <StackTable
          capped={projectsCapped(rows.length)}
          className="orghome-projects"
        >
          <ProjectsTableHead />
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="has-control is-main">
                  <Link
                    href={`/projects/${encodeURIComponent(r.id)}`}
                    className="link-strong"
                    lang={r.lang}
                  >
                    {r.name}
                  </Link>
                </td>
                <td className="num">
                  <StackLabel>{P.columns.documents}</StackLabel>
                  {r.docs}
                </td>
                <td className="num">
                  <StackLabel>{P.columns.keys}</StackLabel>
                  {r.keys}
                </td>
                <td>
                  <span className="badge">{r.visibility}</span>
                </td>
                <td className="nowrap">
                  <StackLabel>{P.columns.created}</StackLabel>
                  {r.created}
                </td>
                <td className="nowrap">
                  <StackLabel>{P.columns.lastUsed}</StackLabel>
                  {r.used}
                </td>
              </tr>
            ))}
          </tbody>
        </StackTable>
      ) : (
        <Block className="panel-body has-rule">
          <BlockText>{P.empty}</BlockText>
        </Block>
      )}
    </Panel>
  );
}
