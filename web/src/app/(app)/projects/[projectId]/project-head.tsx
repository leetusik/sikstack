"use client";

import Link from "next/link";
import { useReducer, useState } from "react";

import { PROJECT_HOME } from "@/content/project";
import { publishToast } from "@/sikstack/shell";
import { Badge, buttonClass, Notice, Skeleton } from "@/sikstack/ui";

import { setProjectVisibilityAction } from "./actions";
import {
  flip,
  visibilityOutcome,
  visibilityReducer,
  visibilityToast,
  type Visibility,
} from "./model";

const W = PROJECT_HOME.head;

/** The back link to org home (`.back`, accessible name `Back to <org>`). */
function Back({ org }: { org: string }) {
  return (
    <Link href="/dashboard" className="back" aria-label={W.back(org)}>
      {org}
    </Link>
  );
}

/**
 * The head (`ProjectHomeHead.dc.html`): the back link, the project's name with its Public or Private
 * badge and `Created …`, and **Make public** / **Make private** at the end. Pressed: Saving… at the
 * same width, a second press does nothing; saved: the badge and the label change and a toast says
 * what the change means; refused: the notice under the head, the button ready again. No confirm (F3).
 *
 * The head stays mounted across the refresh a saved change brings (the button keeps focus); the
 * server's visibility is taken when it differs from what the head shows (`sync`).
 *
 * Publishing is an org act (P78-s2.F1): the switch is the org owner's, so a member's head (or one whose role read
 * failed) shows the badge alone; the API refuses a member's change either way.
 */
export function ProjectHead({
  projectId,
  name,
  org,
  created,
  visibility,
  owner,
}: {
  projectId: string;
  name: string;
  org: string;
  /** The created date, already formatted (`Mar 2`). */
  created: string;
  visibility: Visibility;
  /** The viewer owns the org: only then is the public/private switch drawn. */
  owner: boolean;
}) {
  const [state, dispatch] = useReducer(visibilityReducer, {
    visibility,
    phase: "idle",
  });
  const [seen, setSeen] = useState(visibility);
  if (visibility !== seen) {
    setSeen(visibility);
    dispatch({ type: "sync", visibility });
  }
  const saving = state.phase === "saving";
  const shown = state.visibility;

  const press = async () => {
    if (saving) return;
    const next = flip(shown);
    dispatch({ type: "press" });
    const form = new FormData();
    form.set("projectId", projectId);
    form.set("visibility", next);
    let outcome: "saved" | "refused" = "refused";
    try {
      outcome = visibilityOutcome(
        await setProjectVisibilityAction({ error: null }, form),
      );
    } catch {
      outcome = "refused";
    }
    dispatch({ type: outcome });
    if (outcome === "saved") publishToast(visibilityToast(next, name, org));
  };

  return (
    <div className="stack">
      <header className="page-top">
        <Back org={org} />
        <div className="page-head">
          <div className="page-title">
            <h1>{name}</h1>
            <Badge>
              {shown === "public" ? W.badge.public : W.badge.private}
            </Badge>
            <span className="meta">{W.created(created)}</span>
          </div>
          {owner ? (
            <button
              type="button"
              className={buttonClass("default", "ph-end")}
              data-busy={saving ? "true" : undefined}
              aria-busy={saving ? true : undefined}
              onClick={press}
            >
              <span className="ph-swap">
                <span
                  className={
                    !saving && shown === "private" ? "is-on" : undefined
                  }
                >
                  {W.makePublic}
                </span>
                <span
                  className={
                    !saving && shown === "public" ? "is-on" : undefined
                  }
                >
                  {W.makePrivate}
                </span>
                <span className={saving ? "is-on" : undefined}>{W.saving}</span>
              </span>
            </button>
          ) : null}
        </div>
      </header>
      {state.phase === "failed" ? (
        <Notice danger role="alert">
          {W.failed}
        </Notice>
      ) : null}
    </div>
  );
}

/** The head while the page loads: the back link, and the `h1` holding a 7em skeleton. */
export function ProjectHeadLoading({ org }: { org: string }) {
  return (
    <div className="stack">
      <header className="page-top">
        <Back org={org} />
        <div className="page-head">
          <div className="page-title">
            <h1 aria-busy="true">
              <Skeleton width="7em" />
              <span className="sr-only">{PROJECT_HOME.loading}</span>
            </h1>
          </div>
        </div>
      </header>
    </div>
  );
}
