"use client";

import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { SHELL } from "@/content/app";
import { ACCOUNT } from "@/content/account";
import { ORG_SHELL } from "@/content/org";
import { plural } from "@/lib/format";

import {
  closeMenuOnEscape,
  filterProjects,
  hasProjectSwitcher,
  initialOf,
  projectCountText,
  projectIdOf,
  projectSwitchHref,
  railFor,
  reviewCount,
  showsProjectFilter,
  type RailItem,
  type ShellOrg,
  type ShellProject,
} from "./model";

export interface ShellProps {
  /** The active org. */
  org: { id: string; name: string };
  /** Every org of the account, in the API's order. */
  orgs: ShellOrg[];
  /** The active org's projects, newest first. */
  projects: ShellProject[];
  email: string;
  /** Cards due (Review's count). */
  due: number;
  /** Where an org pick posts (the org switch route). */
  orgRoute: string;
}

type MenuKey = "org" | "project" | "account";

const ORG_HOME = "/dashboard";
/** New org (P78-s2.S2's design): the org menu's foot leads there. */
const NEW_ORG = "/orgs/new";
/** The account page (P78, F10): the account menu's link, before Sign out. */
const ACCOUNT_PAGE = "/account";
/** The rail's words, the org form's Members with them. */
const RAIL_WORDS = { ...SHELL.rail, members: ORG_SHELL.members };

/**
 * The Shell (frame.md F9; `Shell.dc.html`): the top bar (wordmark, org switcher, project switcher,
 * account menu) and one `nav` with the rail. Rendered straight into `.app-frame`, so the frame's grid
 * places the bar, the rail (a strip under 72em) and the main column. It never folds.
 *
 * The rail and the current project follow the path (`usePathname`), so the Shell lives in a shared
 * layout and stays right across client navigation. Menus: one open at a time; Escape closes and puts
 * focus back on the trigger; a click outside, or focus leaving the menu, closes it; every arrival
 * closes what was open (the flow: "nothing that was open on it is still open").
 *
 * The org switcher is a menu for every account, one org too (P78-s2.S2's design): its orgs, the current
 * one checked, then a rule and New org, the way to make another.
 */
export function Shell({
  org,
  orgs,
  projects,
  email,
  due,
  orgRoute,
}: ShellProps) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const [open, setOpen] = useState<MenuKey | null>(null);
  const [query, setQuery] = useState("");
  const [seenPath, setSeenPath] = useState(pathname);
  const signingOut = useRef(false);

  // A new address closes any open menu (React's "adjust state while rendering", no effect).
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setOpen(null);
    setQuery("");
  }

  const set = (key: MenuKey | null) => {
    setOpen(key);
    setQuery("");
  };
  const toggle = (key: MenuKey) => () => set(open === key ? null : key);

  // A click outside the open menu's anchor closes it, the top bar's own blank space included
  // (the scrim covers the page below the bar).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(`[data-shell-menu="${open}"]`)) return;
      setOpen(null);
      setQuery("");
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    closeMenuOnEscape(event, open !== null, () => set(null));
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (open && next instanceof Node && !event.currentTarget.contains(next))
      set(null);
  };
  const anchorProps = (key: MenuKey) => ({
    className: "menu-anchor",
    onKeyDown: onKey,
    onBlur,
    "data-shell-menu": key,
  });

  async function signOut() {
    if (signingOut.current) return;
    signingOut.current = true;
    set(null);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // navigate anyway: the server guard re-checks on the next load
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  const projectId = projectIdOf(pathname);
  const project = projects.find((p) => p.id === projectId) ?? null;
  const shown = filterProjects(projects, query);
  const rail = railFor(pathname, project !== null);
  const count = reviewCount(due);

  return (
    <>
      <header className="top">
        <div className="top-row">
          <Link
            className="mark"
            href={ORG_HOME}
            aria-label={SHELL.homeLabel(org.name)}
          >
            {SHELL.wordmark}
          </Link>
          <div className="crumbs">
            <div {...anchorProps("org")}>
              <button
                type="button"
                className="switch"
                aria-haspopup="true"
                aria-expanded={open === "org"}
                aria-label={SHELL.orgLabel(org.name)}
                onClick={toggle("org")}
              >
                <span className="switch-label">{org.name}</span>
                <span className="chev" aria-hidden="true" />
              </button>
              {open === "org" ? (
                // A plain form post: the org switch route confirms the membership and lands on
                // org home (the current org too, F9). New org is a link, after the rule.
                <form
                  className="menu"
                  role="group"
                  aria-label={SHELL.switchOrg}
                  method="post"
                  action={orgRoute}
                >
                  <p className="menu-title">{SHELL.switchOrg}</p>
                  <div className="menu-list">
                    {orgs.map((o) => (
                      <button
                        key={o.id}
                        type="submit"
                        name="org"
                        value={o.id}
                        className="menu-item"
                        aria-current={o.id === org.id ? "true" : undefined}
                      >
                        <span className="menu-check" aria-hidden="true" />
                        <span className="menu-name">{o.name}</span>
                        {o.projects !== null ? (
                          <span className="menu-end">
                            {plural(o.projects, SHELL.project)}
                          </span>
                        ) : null}
                        <span className="menu-sub">
                          {o.address ?? SHELL.noPublicUrl}
                        </span>
                      </button>
                    ))}
                  </div>
                  <span className="menu-rule" aria-hidden="true" />
                  <Link
                    className="menu-item is-plain"
                    href={NEW_ORG}
                    onClick={() => set(null)}
                  >
                    {ORG_SHELL.newOrg}
                  </Link>
                </form>
              ) : null}
            </div>
            {hasProjectSwitcher(projects) ? (
              <>
                <span className="crumb-sep" aria-hidden="true">
                  /
                </span>
                <div {...anchorProps("project")}>
                  <button
                    type="button"
                    className="switch"
                    aria-haspopup="true"
                    aria-expanded={open === "project"}
                    aria-label={
                      project
                        ? SHELL.projectLabel(project.name)
                        : SHELL.selectProjectIn(org.name)
                    }
                    onClick={toggle("project")}
                  >
                    <span
                      className={
                        project ? "switch-label" : "switch-label is-unset"
                      }
                    >
                      {project ? project.name : SHELL.selectProject}
                    </span>
                    <span className="chev" aria-hidden="true" />
                  </button>
                  {open === "project" ? (
                    <div
                      className="menu"
                      role="group"
                      aria-label={SHELL.projects}
                    >
                      <p className="menu-title split">
                        <span>{SHELL.projects}</span>
                        <span>
                          {projectCountText(
                            query,
                            shown.length,
                            projects.length,
                          )}
                        </span>
                      </p>
                      {showsProjectFilter(projects.length) ? (
                        <div className="menu-filter">
                          <input
                            className="input"
                            type="search"
                            aria-label={SHELL.findProject}
                            placeholder={SHELL.findProject}
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                          />
                        </div>
                      ) : null}
                      <div className="menu-list">
                        {shown.map((p) => (
                          <Link
                            key={p.id}
                            className="menu-item"
                            href={projectSwitchHref(pathname, p.id)}
                            aria-current={
                              project && p.id === project.id
                                ? "true"
                                : undefined
                            }
                            onClick={() => set(null)}
                          >
                            <span className="menu-check" aria-hidden="true" />
                            <span className="menu-name">{p.name}</span>
                            <span className="menu-end">
                              {SHELL.visibility[p.visibility] ??
                                SHELL.visibility.private}
                            </span>
                          </Link>
                        ))}
                        {shown.length === 0 ? (
                          <p className="menu-empty">
                            {SHELL.noMatch(query.trim())}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
          <div className="top-end">
            <div {...anchorProps("account")}>
              <button
                type="button"
                className="account"
                aria-haspopup="true"
                aria-expanded={open === "account"}
                aria-label={SHELL.accountLabel(email)}
                onClick={toggle("account")}
              >
                <span className="avatar" aria-hidden="true">
                  {initialOf(email)}
                </span>
              </button>
              {open === "account" ? (
                <div
                  className="menu at-end"
                  role="group"
                  aria-label={SHELL.account}
                >
                  <p className="menu-title">{email}</p>
                  <Link
                    className="menu-item is-plain"
                    href={ACCOUNT_PAGE}
                    aria-current={pathname === ACCOUNT_PAGE ? "page" : undefined}
                    onClick={() => set(null)}
                  >
                    {ACCOUNT.menuLink}
                  </Link>
                  <button
                    type="button"
                    className="menu-item is-plain"
                    onClick={signOut}
                  >
                    {SHELL.signOut}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </header>
      <nav className="rail" aria-label={SHELL.sections}>
        {rail.items.map((item) => (
          <RailEntry key={item.key} item={item} />
        ))}
        <span className="rail-rule" aria-hidden="true" />
        <Link
          className="nav-item"
          href={rail.review.href ?? "/review"}
          aria-current={rail.review.current ? "page" : undefined}
          aria-label={
            count
              ? SHELL.reviewDueLabel(plural(due, SHELL.card))
              : SHELL.rail.review
          }
        >
          <span className="nav-pill">
            {SHELL.rail.review}
            {count ? <span className="count">{count}</span> : null}
          </span>
        </Link>
      </nav>
      {open ? (
        <div
          className="menu-scrim"
          aria-hidden="true"
          onClick={() => set(null)}
        />
      ) : null}
    </>
  );
}

/** A rail item: a link, the current one `aria-current="page"`. */
function RailEntry({ item }: { item: RailItem }) {
  const label = RAIL_WORDS[item.key];
  return (
    <Link
      className="nav-item"
      href={item.href}
      aria-current={item.current ? "page" : undefined}
    >
      <span className="nav-pill">{label}</span>
    </Link>
  );
}
