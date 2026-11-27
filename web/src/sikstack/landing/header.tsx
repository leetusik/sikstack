"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { LANDING, LANDING_LINKS, LANDING_PARTS } from "@/content/marketing";
import { buttonClass } from "@/sikstack/ui";

import { Wordmark } from "./wordmark";

/** How far the page scrolls before the header becomes its bar (F255, `## Interaction states`). */
const SCROLLED_AT = 12;

/**
 * The landing's header (job 06 G1, F255, `LandingHeader.dc.html`): sticky, 56 px; the skip link
 * first, in its band; the wordmark to the top, the four part links, Sign in (quiet) and Create account
 * (secondary). Under 56em of its width the wordmark and **Menu**: the menu opens over the page and
 * closes on a link, on Menu and on Escape (focus back to Menu). After 12 px of scroll it is the bar
 * (`.is-scrolled`). Signed in (P78, F8), **Dashboard** (secondary) stands in for Sign in and Create account,
 * in the bar and in the menu.
 *
 * P87's mark (direction C, "Live dot"): the wordmark's link holds `Wordmark` (`./wordmark`), the name with the
 * dot of its i in the accent, in place of the name as plain text.
 */
export function LandingHeader({ signedIn = false }: { signedIn?: boolean }) {
  const words = LANDING.header;
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > SCROLLED_AT);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const close = () => setOpen(false);
  const links = LANDING_PARTS.map((part) => (
    <a key={part.id} className="lp-link" href={`#${part.id}`} onClick={close}>
      {part.label}
    </a>
  ));

  return (
    <header
      className={scrolled ? "lp-head is-scrolled" : "lp-head"}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          setOpen(false);
          menuButton.current?.focus();
        }
      }}
    >
      <div className="lp-skip-band">
        <div className="center lp-head-row">
          <a className="btn lp-skip" href="#main">
            {words.skip}
          </a>
        </div>
      </div>
      <div className="center lp-head-row">
        <a className="mark lp-mark" href="#top" onClick={close}>
          <Wordmark />
        </a>
        <nav className="lp-nav" aria-label={words.nav}>
          {links}
        </nav>
        <div className="lp-head-end">
          {signedIn ? (
            <Link className={buttonClass()} href={LANDING_LINKS.dashboard}>
              {words.dashboard}
            </Link>
          ) : (
            <>
              <Link
                className={buttonClass("quiet")}
                href={LANDING_LINKS.signIn}
              >
                {words.signIn}
              </Link>
              <Link
                className={buttonClass()}
                href={LANDING_LINKS.createAccount}
              >
                {words.createAccount}
              </Link>
            </>
          )}
        </div>
        <button
          ref={menuButton}
          type="button"
          className="btn btn-quiet lp-menu-btn"
          aria-expanded={open}
          aria-controls="lp-menu"
          onClick={() => setOpen(!open)}
        >
          {words.menu}
          <span className="chev" aria-hidden="true" />
        </button>
      </div>
      {open ? (
        <div className="lp-menu" id="lp-menu">
          <nav className="lp-menu-list center" aria-label={words.nav}>
            {links}
          </nav>
          <div className="lp-menu-actions center">
            {signedIn ? (
              <Link
                className={buttonClass("primary")}
                href={LANDING_LINKS.dashboard}
                onClick={close}
              >
                {words.dashboard}
              </Link>
            ) : (
              <>
                <Link
                  className={buttonClass()}
                  href={LANDING_LINKS.signIn}
                  onClick={close}
                >
                  {words.signIn}
                </Link>
                <Link
                  className={buttonClass("primary")}
                  href={LANDING_LINKS.createAccount}
                  onClick={close}
                >
                  {words.createAccount}
                </Link>
              </>
            )}
          </div>
        </div>
      ) : null}
    </header>
  );
}
