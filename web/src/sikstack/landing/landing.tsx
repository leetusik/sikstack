import Link from "next/link";

import { LANDING, LANDING_LINKS, LANDING_PARTS } from "@/content/marketing";
import { Copy } from "@/sikstack/frame";
import { SendFeedback } from "@/sikstack/send-feedback";
import { Badge, buttonClass, Status, UiRoot } from "@/sikstack/ui";

import { LandingHeader } from "./header";
import "./landing.css";

/**
 * The public landing at `/` (job 06, round 01-landing, signed: `Main.dc.html` and its `## Build`).
 * No Shell: one `UiRoot` following the system scheme, then `.lp` (the landing's size container) >
 * the header > `main#main.lp-main` > the hero and the four parts, each `.center.lp-row` with its words
 * (`.lp-text`) and its picture (`.lp-pic`) > the footer. The pictures are the app's own panels drawn
 * as pictures (`role="img"` with a label, F257): static, nothing in them to click. Every word is
 * `@/content/marketing`. Second on the page, the diagram's section (job 08, round
 * 01-landing-diagram-feedback, signed: its `## Build` 3a-3b): `figure.lp-map`, its parts and their
 * arrangement in `landing.css`. After the Workspace, the install section (job 09, round
 * 01-install-and-connect, signed: its `## Build` *The landing's block (S5)*): its words, then
 * `div.lpi`, the plugin's three numbered steps and how work starts, each command a block `Copy`. In the footer, after the five links, the feedback control's trigger
 * (job 08's `## Build` 3c-3d): only when the page passes `sendFeedback`, which it does only where the server
 * holds the control's key; without it the footer's row holds the links alone, the signed footer.
 *
 * Applied, this file is `src/sikstack/landing/landing.tsx`. P83-8k.S1's design changes only the Connect section:
 * the plugin's sign-in (a block `Copy` of `/sikstack:sign-in`) and the connect page's confirm, in place of the CLI
 * install, the two variables and the "Mint an org key" link; its words column loses the GitHub link (the install
 * section keeps "The plugin on GitHub"). Every other part is production's, as it is.
 *
 * P87's design (the "sik" mark and the open-source section, signed in `web/design`) adds the open-source
 * section (`#open-source`), the last part of
 * `main`, in the parts' own row. Its words say the licence and where the code is, with one secondary button to
 * the repo; beside them, under "Contribute", one row of links: the feedback control's trigger (a second one, on
 * the footer's own condition, `sendFeedback`), the repo's issues, its pull requests and `CONTRIBUTING.md`. The
 * header's mark is `./header`'s; the footer is production's, as it is.
 */
const external = { target: "_blank", rel: "noopener noreferrer" } as const;

export interface LandingProps {
  /** The feedback control's settings, read per request; left out where the server holds no key (F408). */
  sendFeedback?: { limit: number };
  /**
   * A live session reads the page (P78, F8): the header and the hero lead to the dashboard in place of Sign in
   * and Create account.
   */
  signedIn?: boolean;
}

export function Landing({ sendFeedback, signedIn = false }: LandingProps) {
  const {
    picture,
    how,
    workspace,
    install,
    library,
    feedback,
    connect,
    openSource,
  } = LANDING;
  return (
    <UiRoot lang="en">
      <div className="lp" id="top">
        <LandingHeader signedIn={signedIn} />
        <main className="lp-main" id="main" tabIndex={-1}>
          <section className="lp-part" aria-labelledby="lp-h1">
            <div className="center lp-row">
              <div className="lp-text">
                <h1 className="lp-h1" id="lp-h1">
                  {LANDING.hero.title}
                </h1>
                <p className="lp-lede">{LANDING.hero.lede}</p>
                <div className="cluster">
                  {signedIn ? (
                    <Link
                      className={buttonClass("primary")}
                      href={LANDING_LINKS.dashboard}
                    >
                      {LANDING.hero.dashboard}
                    </Link>
                  ) : (
                    <>
                      <Link
                        className={buttonClass("primary")}
                        href={LANDING_LINKS.createAccount}
                      >
                        {LANDING.hero.createAccount}
                      </Link>
                      <Link
                        className={buttonClass()}
                        href={LANDING_LINKS.signIn}
                      >
                        {LANDING.hero.signIn}
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
                    <div className="panel lp-shot-wide">
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
                        <span className="lp-pt">{picture.library.title}</span>
                        <span className="meta">{picture.library.meta}</span>
                      </div>
                      <ul className="lp-list">
                        {picture.library.docs.map((d) => (
                          <li key={d.title} className="row lp-doc">
                            <span className="strong" lang={d.lang}>
                              {d.title}
                            </span>
                            <span className="dim">{d.length}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="panel">
                      <div className="panel-head">
                        <span className="lp-pt">{picture.feedback.title}</span>
                        <span className="meta">{picture.feedback.meta}</span>
                      </div>
                      <ul className="lp-list">
                        {picture.feedback.messages.map((m) => (
                          <li key={m.text} className="row lp-msg">
                            <span className="strong">{m.rating}</span>
                            <span>{m.text}</span>
                            <span className="dim lp-when">{m.when}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </figure>
              </div>
            </div>
          </section>

          <section className="lp-part" aria-labelledby="lp-how">
            <div className="center lp-row">
              <div className="lp-text">
                <h2 className="lp-h2" id="lp-how">
                  {how.title}
                </h2>
                <p>{how.text}</p>
              </div>
              <div className="lp-pic">
                <figure className="lp-map" role="img" aria-label={how.label}>
                  <div className="lp-map-chain lp-fit">
                    <div className="lp-map-box lp-fit-feedback">
                      <span className="lp-map-name">{how.feedback.name}</span>
                      <span className="dim">{how.feedback.line}</span>
                    </div>
                    <div className="lp-map-link lp-fit-to-workspace">
                      <span className="lp-map-line" aria-hidden="true" />
                      <span className="lp-map-label">{how.toWorkspace}</span>
                    </div>
                    <div className="lp-map-box lp-fit-workspace">
                      <span className="lp-map-name">
                        {how.workspace.name}
                      </span>
                      <span className="dim">{how.workspace.line}</span>
                    </div>
                    <div className="lp-map-link is-down lp-fit-to-agent">
                      <span
                        className="lp-map-line is-both"
                        aria-hidden="true"
                      />
                      <span className="lp-map-label">{how.toAgent}</span>
                    </div>
                    <div className="lp-map-box is-agent lp-fit-agent">
                      <span className="lp-map-name">{how.agent.name}</span>
                      <span className="dim">{how.agent.line}</span>
                    </div>
                    <div className="lp-map-link is-down lp-fit-to-library">
                      <span className="lp-map-line" aria-hidden="true" />
                      <span className="lp-map-label">{how.toLibrary}</span>
                    </div>
                    <div className="lp-map-box lp-fit-library">
                      <span className="lp-map-name">{how.library.name}</span>
                      <span className="dim">{how.library.line}</span>
                    </div>
                  </div>
                </figure>
              </div>
            </div>
          </section>

          <section className="lp-part" id="workspace" aria-labelledby="lp-ws">
            <div className="center lp-row">
              <div className="lp-text">
                <h2 className="lp-h2" id="lp-ws">
                  {workspace.title}
                </h2>
                <p>{workspace.text}</p>
              </div>
              <div className="lp-pic">
                <div
                  className="panel"
                  role="img"
                  aria-label={workspace.picture.label}
                >
                  <div className="panel-head">
                    <span className="lp-pt">{workspace.picture.title}</span>
                    <span className="meta">{workspace.picture.meta}</span>
                  </div>
                  <ul className="lp-list">
                    {workspace.picture.items.map((a) => (
                      <li key={a.title} className="row lp-ag">
                        <span className="row-stack">
                          <span className="strong">{a.title}</span>
                          {a.fromFeedback ? (
                            <span className="meta">
                              {workspace.picture.fromFeedback}
                            </span>
                          ) : null}
                        </span>
                        <span className="lp-state lp-outcome">
                          {a.phase ? (
                            <span className="dim lp-outcome-ph">{a.phase}</span>
                          ) : null}
                          <span className="lp-outcome-st">
                            <Status state={a.status}>{a.word}</Status>
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </section>

          <section className="lp-part" id="install" aria-labelledby="lp-inst">
            <div className="center lp-row">
              <div className="lp-text">
                <h2 className="lp-h2 lp-inst-h2" id="lp-inst">
                  {install.title}
                </h2>
                <p>{install.noAccount}</p>
                <p>
                  {install.signInBefore}
                  <span className="lp-code-inline">{install.signIn}</span>
                  {install.signInAfter}
                </p>
                <p>
                  {install.needs.map((part, i) =>
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
                  href={install.repo.href}
                  {...external}
                >
                  {install.repo.label}
                </a>
              </div>
              <div className="lp-pic">
                <div className="lpi">
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

          <section className="lp-part" id="library" aria-labelledby="lp-lib">
            <div className="center lp-row">
              <div className="lp-text">
                <h2 className="lp-h2" id="lp-lib">
                  {library.title}
                </h2>
                <p>{library.text}</p>
                <ul className="lp-facts">
                  {library.facts.map((fact) => (
                    <li key={fact}>{fact}</li>
                  ))}
                  <li>
                    <span>{library.assistant}</span>
                    <Badge>{library.coming}</Badge>
                  </li>
                </ul>
              </div>
              <div className="lp-pic">
                <div
                  className="panel"
                  role="img"
                  aria-label={library.picture.label}
                >
                  <div className="panel-head">
                    <span className="lp-pt">{library.picture.title}</span>
                  </div>
                  <div className="panel-body has-rule lp-read">
                    <div className="lp-read-top">
                      <p className="cluster meta gap-3">
                        <span>{library.picture.project}</span>
                        <span>{library.picture.length}</span>
                        <span>{library.picture.date}</span>
                      </p>
                      <span className="lp-tools">
                        {library.picture.tools.map((tool) => (
                          <span key={tool} className="lp-tool">
                            {tool}
                          </span>
                        ))}
                      </span>
                    </div>
                    <p className="lp-read-text">
                      {library.picture.before}
                      <mark>{library.picture.mark}</mark>
                      {library.picture.after}
                    </p>
                    <p className="lp-note">
                      <span className="meta strong">
                        {library.picture.noteLabel}
                      </span>
                      <span>{library.picture.note}</span>
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="lp-part" id="feedback" aria-labelledby="lp-fb">
            <div className="center lp-row">
              <div className="lp-text">
                <h2 className="lp-h2" id="lp-fb">
                  {feedback.title}
                </h2>
                <p>{feedback.text}</p>
              </div>
              <div className="lp-pic">
                <div
                  className="panel"
                  role="img"
                  aria-label={feedback.picture.label}
                >
                  <div className="panel-head">
                    <span className="lp-pt">{feedback.picture.rated}</span>
                    <span className="meta">{feedback.picture.when}</span>
                  </div>
                  <div className="panel-body has-rule">
                    <p className="lp-said">{feedback.picture.text}</p>
                  </div>
                  <div className="panel-body has-rule split">
                    <Status state="live">{feedback.picture.onAgenda}</Status>
                    <span className="meta">{feedback.picture.sent}</span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="lp-part" id="connect" aria-labelledby="lp-con">
            <div className="center lp-row">
              <div className="lp-text">
                <h2 className="lp-h2" id="lp-con">
                  {connect.title}
                </h2>
                <p>{connect.text}</p>
              </div>
              <div className="lp-pic stack gap-6">
                <div className="stack gap-3">
                  <h3 className="lp-h3">{connect.signIn.title}</h3>
                  <Copy
                    block
                    text={connect.signIn.command}
                    what={connect.signIn.what}
                  />
                </div>
                <div className="stack gap-3">
                  <h3 className="lp-h3">{connect.confirm.title}</h3>
                  <p>{connect.confirm.text}</p>
                </div>
              </div>
            </div>
          </section>

          <section
            className="lp-part"
            id="open-source"
            aria-labelledby="lp-os"
          >
            <div className="center lp-row">
              <div className="lp-text">
                <h2 className="lp-h2" id="lp-os">
                  {openSource.title}
                </h2>
                <p>{openSource.text}</p>
                <a
                  className={buttonClass()}
                  href={openSource.repo.href}
                  {...external}
                >
                  {openSource.repo.label}
                </a>
              </div>
              <div className="lp-pic stack gap-1">
                <h3 className="lp-h3" id="lp-os-ways">
                  {openSource.contribute.title}
                </h3>
                <ul className="lp-ways" aria-labelledby="lp-os-ways">
                  {sendFeedback ? (
                    <li>
                      <SendFeedback
                        context="visitor"
                        limit={sendFeedback.limit}
                        triggerClassName="link link-row"
                      />
                    </li>
                  ) : null}
                  {openSource.contribute.links.map((way) => (
                    <li key={way.href}>
                      <a
                        className="link link-row"
                        href={way.href}
                        {...external}
                      >
                        {way.label}
                      </a>
                    </li>
                  ))}
                </ul>
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
