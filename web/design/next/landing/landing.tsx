import Link from "next/link";

import { Copy } from "@/sikstack/frame";
// Applied: `./header` (the header is production's, unchanged; its words come from the next copy through the
// design build's `@/content/marketing` alias).
import { LandingHeader } from "@/sikstack/landing/header";
import { SendFeedback } from "@/sikstack/send-feedback";
import { Badge, buttonClass, Status, UiRoot } from "@/sikstack/ui";

// Applied: `@/content/marketing` (this design keeps the new words at `next/content/marketing/landing.ts`).
import { LANDING, LANDING_LINKS, LANDING_PARTS } from "../content/marketing/landing";
import "./landing.css";

/**
 * The public landing at `/`, around the plugin (P83-8k.S1's design; first signed as job 06, round 01-landing).
 * No Shell: one `UiRoot` following the system scheme, then `.lp` (the landing's size container) > the header >
 * `main#main.lp-main` > two parts, each `.center.lp-row` with its words (`.lp-text`) and its picture (`.lp-pic`)
 * > the footer. Every word is `@/content/marketing`.
 *
 * - The hero: what sikstack does in Claude Code, then the install beside it (job 09's block, `div.lpi`
 *   `#install`): the plugin's three numbered steps and how work starts, each command a block `Copy`.
 * - On the web (`#web`): the sign-in path, the account actions (Open dashboard when signed in, P78 F8), and a
 *   picture of the two parts the plugin feeds, the Workspace's phases and Design's builds: the app's own panels
 *   drawn as a picture (`role="img"` with a label, F257), static.
 * - In the footer, after the links, the feedback control's trigger (job 08's `## Build` 3c-3d): only when the page
 *   passes `sendFeedback`, which it does only where the server holds the control's key.
 */
const external = { target: "_blank", rel: "noopener noreferrer" } as const;

export interface LandingProps {
  /** The feedback control's settings, read per request; left out where the server holds no key (F408). */
  sendFeedback?: { limit: number };
  /**
   * A live session reads the page (P78, F8): the header and the web part lead to the dashboard in place of Sign
   * in and Create account.
   */
  signedIn?: boolean;
}

export function Landing({ sendFeedback, signedIn = false }: LandingProps) {
  const { hero, install, web } = LANDING;
  const { picture } = web;
  return (
    <UiRoot lang="en">
      <div className="lp" id="top">
        <LandingHeader signedIn={signedIn} />
        <main className="lp-main" id="main" tabIndex={-1}>
          <section className="lp-part" aria-labelledby="lp-h1">
            <div className="center lp-row">
              <div className="lp-text">
                <h1 className="lp-h1" id="lp-h1">
                  {hero.title}
                </h1>
                <p className="lp-lede">{hero.lede}</p>
                <p>{hero.noAccount}</p>
                <p>
                  {hero.needs.map((part, i) =>
                    typeof part === "string" ? (
                      part
                    ) : (
                      <span key={i} className="lp-code-inline">
                        {part.code}
                      </span>
                    ),
                  )}
                </p>
                <a
                  className="link link-row"
                  href={hero.repo.href}
                  {...external}
                >
                  {hero.repo.label}
                </a>
              </div>
              <div className="lp-pic">
                <div className="lpi" id="install">
                  <h2 className="sr-only">{install.label}</h2>
                  <ol className="lpi-steps">
                    {install.steps.map((step) => (
                      <li key={step.n} className="lpi-step">
                        <span className="lpi-n" aria-hidden="true">
                          {step.n}
                        </span>
                        <div className="stack gap-3">
                          <h3 className="lp-h3">{step.title}</h3>
                          <Copy block text={step.command} what={step.what} />
                        </div>
                      </li>
                    ))}
                  </ol>
                  <div className="lpi-step">
                    <span className="lpi-n" aria-hidden="true" />
                    <div className="stack gap-3">
                      <h3 className="lp-h3">{install.work.title}</h3>
                      <Copy
                        block
                        text={install.work.command}
                        what={install.work.what}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="lp-part" id="web" aria-labelledby="lp-web">
            <div className="center lp-row">
              <div className="lp-text">
                <h2 className="lp-h2" id="lp-web">
                  {web.title}
                </h2>
                <p>
                  {web.textBefore}
                  <span className="lp-code-inline">{web.command}</span>
                  {web.textAfter}
                </p>
                <div className="cluster">
                  {signedIn ? (
                    <Link
                      className={buttonClass("primary")}
                      href={LANDING_LINKS.dashboard}
                    >
                      {web.dashboard}
                    </Link>
                  ) : (
                    <>
                      <Link
                        className={buttonClass("primary")}
                        href={LANDING_LINKS.createAccount}
                      >
                        {web.createAccount}
                      </Link>
                      <Link
                        className={buttonClass()}
                        href={LANDING_LINKS.signIn}
                      >
                        {web.signIn}
                      </Link>
                    </>
                  )}
                </div>
              </div>
              <div className="lp-pic">
                <figure
                  className="lp-shot"
                  role="img"
                  aria-label={picture.label}
                >
                  <div className="lp-shot-crumb">
                    <span className="strong">{picture.org}</span>
                    <span className="lp-shot-sep">/</span>
                    <span className="lp-pt">{picture.project}</span>
                    <Badge>{picture.visibility}</Badge>
                  </div>
                  <div className="lp-shot-grid">
                    <div className="panel">
                      <div className="panel-head">
                        <span className="lp-pt">{picture.workspace.title}</span>
                        <span className="meta">{picture.workspace.meta}</span>
                      </div>
                      <ul className="lp-list">
                        {picture.workspace.phases.map((ph) => (
                          <li key={ph.id} className="row lp-ph">
                            <span className="dim">{ph.id}</span>
                            <span className="strong">{ph.name}</span>
                            <span className="lp-state">
                              <Status state={ph.status}>{ph.word}</Status>
                              <span className="dim lp-count">{ph.count}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="panel">
                      <div className="panel-head">
                        <span className="lp-pt">{picture.design.title}</span>
                        <span className="meta">{picture.design.meta}</span>
                      </div>
                      <ul className="lp-list">
                        {picture.design.builds.map((b) => (
                          <li key={b.commit} className="row lp-ph">
                            <span className="dim mono">{b.commit}</span>
                            <span className="strong">{b.branch}</span>
                            <span className="lp-state">
                              {b.shared ? (
                                <Status state="live">{b.word}</Status>
                              ) : (
                                <span className="dim">{b.word}</span>
                              )}
                              <span className="dim lp-count">{b.when}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </figure>
              </div>
            </div>
          </section>
        </main>

        <footer className="lp-part lp-foot">
          <div className="center lp-row">
            <a className="mark lp-mark" href="#top">
              {LANDING.wordmark}
            </a>
            <div className="split lp-foot-row">
              <nav className="lp-foot-links" aria-label={LANDING.footer.nav}>
                {LANDING_PARTS.map((part) => (
                  <a key={part.id} className="lp-link" href={`#${part.id}`}>
                    {part.label}
                  </a>
                ))}
                <a
                  className="lp-link"
                  href={LANDING.footer.github.href}
                  {...external}
                >
                  {LANDING.footer.github.label}
                </a>
              </nav>
              {sendFeedback ? (
                <SendFeedback
                  context="visitor"
                  limit={sendFeedback.limit}
                  triggerClassName="lp-link lp-foot-send"
                />
              ) : null}
            </div>
          </div>
        </footer>
      </div>
    </UiRoot>
  );
}
