import Link from "next/link";

import { WS_GLOSSARY, WS_KIND } from "@/content/workspace/frame";
import { PHASE_PAGE } from "@/content/workspace/phase";
import {
  Facts,
  Fact,
  ItemHead,
  RefusedBadge,
  Steps,
  WaitingBadge,
  WsList,
  WsRow,
  WsStatus,
  wsStatus,
  type WsBack,
  type WsSyncLine,
} from "@/sikstack/workspace/frame";
import { Md } from "@/sikstack/workspace/md";
import type { Dates } from "@/lib/workspace/model";
import type {
  Branch,
  Gate,
  Notebook,
  Phase,
  SliceRow,
} from "@/lib/workspace/types";

import { NotebookDecisions } from "./decisions";
import { WsProse } from "@/sikstack/workspace/frame/prose";
import {
  askedDates,
  explainedDocuments,
  gatePlace,
  isCurrentSlice,
  notebookQuestions,
  notebookShows,
  originalParagraphs,
  pullRequestView,
  sliceSub,
  type ExplainedRow,
  type PhaseItemView,
} from "./model";

const G = WS_GLOSSARY;
const L = G.labels.phase;

// -- the head --------------------------------------------------------------------------------------

/** One branch's fact (F306): **Branch in `<repo>`** over the branch over its pull request or the not-opened line. */
function BranchFact({ branch }: { branch: Branch }) {
  const pr = pullRequestView(branch);
  return (
    <div className="fact">
      <dt>{PHASE_PAGE.branch(branch.repo)}</dt>
      <dd className="row-stack">
        <span>{branch.branch ?? G.none}</span>
        {pr.opened ? (
          <span className="phase-pr">
            {pr.href ? (
              <a
                className="link phase-pr-link"
                href={pr.href}
                aria-label={pr.label}
              >
                <span>{pr.text}</span>
              </a>
            ) : (
              <span>{pr.text}</span>
            )}
            {pr.state ? (
              <span className={pr.state.cls}>{pr.state.word}</span>
            ) : null}
          </span>
        ) : (
          <span className="meta">{pr.text}</span>
        )}
      </dd>
    </div>
  );
}

// -- the gate (`PhaseGate.dc.html`) ----------------------------------------------------------------

export function PhaseGate({ gate, date }: { gate: Gate; date: Dates["date"] }) {
  const open = gate.state === "open";
  const cleared = gate.state === "cleared" && !!gate.cleared;
  const hasLead = !!gate.note || cleared;
  const hasBody = hasLead || open;
  return (
    <section className="panel" aria-labelledby="phase-gate-head">
      <div className="panel-head">
        <h2 id="phase-gate-head">{G.heads.gate}</h2>
        <WsStatus kind="gate" value={gate.state} />
      </div>
      {hasBody ? (
        <div className="panel-body has-rule stack gap-4">
          {hasLead ? (
            <div className="stack gap-2">
              {cleared ? (
                <p>{G.sentences.cleared(date(gate.cleared))}</p>
              ) : null}
              {gate.note ? (
                <p className="phase-gate-text">
                  <WsProse text={gate.note} />
                </p>
              ) : null}
            </div>
          ) : null}
          {open ? (
            <>
              <div className="stack gap-2">
                <h3>{G.groups.walkthrough}</h3>
                <div className="md">
                  <ol>
                    {gate.walkthrough.map((step, i) => (
                      <li key={i}>
                        <WsProse text={step} />
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
              <p className="strong phase-gate-text">
                {gate.words ?? G.sentences.gateWords}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// -- slices (`PhaseSlices.dc.html`) ----------------------------------------------------------------

export function PhaseSlices({
  slices,
  current,
  asked,
  href,
}: {
  slices: readonly SliceRow[];
  current: string | null;
  asked: Record<string, string>;
  href: (full: string) => string;
}) {
  return (
    <section className="panel" aria-labelledby="phase-slices-head">
      <div className="panel-head">
        <h2 id="phase-slices-head">{G.heads.slices}</h2>
      </div>
      <ol className="ws-list">
        {slices.map((s) => {
          const sub = sliceSub(s, asked);
          const status = wsStatus("slice", s.status);
          const name = s.name ?? s.full;
          return (
            <li
              key={s.full}
              className="row ws-row"
              aria-current={isCurrentSlice(s, current) ? "step" : undefined}
            >
              <span className="ws-id">{s.id}</span>
              <Link className="link-strong ws-open ws-name" href={href(s.full)}>
                <span className="row-stack">
                  <span
                    className="ws-name-text"
                    lang={HANGUL.test(name) ? "ko" : undefined}
                  >
                    {name}
                  </span>
                  {sub ? (
                    <span className="meta ws-sub ws-prose">
                      <WsProse text={sub} />
                    </span>
                  ) : null}
                </span>
              </Link>
              {status ? (
                <span className={`${status.cls} ws-state`}>{status.word}</span>
              ) : (
                <span className="ws-state" />
              )}
              <span className="dim ws-end">
                {s.kind ? (WS_KIND[s.kind] ?? s.kind) : ""}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

// -- the notebook (`PhaseNotebook.dc.html`) --------------------------------------------------------

export function PhaseNotebook({ notebook }: { notebook: Notebook }) {
  const shows = notebookShows(notebook);
  const [
    nowHead,
    questionsHead,
    decisionsHead,
    docImpactHead,
    notesHead,
    topicsHead,
  ] = G.groups.notebook;
  return (
    <section className="panel" aria-labelledby="phase-notebook-head">
      <div className="panel-head">
        <h2 id="phase-notebook-head">{G.heads.notebook}</h2>
      </div>
      {shows.now ? (
        <div className="phase-group">
          <h3>{nowHead}</h3>
          <div className="phase-now phase-md">
            <WsProse text={notebook.now ?? ""} block />
          </div>
        </div>
      ) : null}
      {shows.questions ? (
        <div className="phase-group">
          <h3>{questionsHead}</h3>
          <ul className="phase-notes">
            {notebookQuestions(notebook.questions).map((q, i) => (
              <li key={`${q.id}-${i}`} className="phase-note">
                <span className="ws-id">{q.id}</span>
                <span className="row-stack phase-note-text phase-md">
                  <span className="strong">
                    <WsProse text={q.text} />
                  </span>
                  {q.answer ? (
                    <span>
                      <WsProse text={q.answer} />
                    </span>
                  ) : null}
                </span>
                <span
                  className={`${q.state === "open" ? "status status-pending" : "status status-done"} phase-note-end`}
                >
                  {q.state === "open" ? G.question.open : G.question.resolved}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {shows.decisions ? (
        <div className="phase-group">
          <h3>{decisionsHead}</h3>
          <NotebookDecisions
            decisions={notebook.decisions}
            texts={notebook.decisions.map((d, i) => (
              <WsProse key={i} text={d.text} />
            ))}
          />
        </div>
      ) : null}
      {shows.docImpact ? (
        <div className="phase-group">
          <h3>{docImpactHead}</h3>
          <ul className="phase-notes">
            {notebook.docImpact.map((n, i) => (
              <li key={i} className="phase-note">
                <span className="ws-id">{n.slice ?? ""}</span>
                <span className="phase-note-text phase-md">
                  <WsProse text={n.text} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {shows.notes ? (
        <div className="phase-group">
          <h3>{notesHead}</h3>
          <ul className="phase-plain phase-md">
            {notebook.notes.map((n, i) => (
              <li key={i}>
                <span>
                  <WsProse text={n.text} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {shows.topics ? (
        <div className="phase-group">
          <h3>{topicsHead}</h3>
          <ul className="phase-plain phase-md">
            {notebook.topics.map((t) => (
              <li key={t.slug} className="row-stack">
                <span className="strong">{`topics/${t.slug}.md`}</span>
                {t.gist ? (
                  <span>
                    <WsProse text={t.gist} />
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

// -- intent ----------------------------------------------------------------------------------------

/** Intent: the operator's words as written, in the Markdown quote style and never parsed; the confirmed intent through `Md`. */
export function PhaseIntent({ intent }: { intent: Phase["intent"] }) {
  const original = originalParagraphs(intent.original);
  const confirmed = intent.confirmed?.trim() ? intent.confirmed : null;
  if (original.length === 0 && !confirmed) return null;
  return (
    <section className="panel" aria-labelledby="phase-intent-head">
      <div className="panel-head">
        <h2 id="phase-intent-head">{G.heads.intent}</h2>
      </div>
      {original.length > 0 ? (
        <div className="panel-body has-rule stack gap-2">
          <h3>{G.groups.intent.original}</h3>
          <div className="md">
            <blockquote>
              {original.map((lines, i) => (
                <p key={i}>
                  {lines.map((line, j) => (
                    <span key={j}>
                      {j > 0 ? <br /> : null}
                      {line}
                    </span>
                  ))}
                </p>
              ))}
            </blockquote>
          </div>
        </div>
      ) : null}
      {confirmed ? (
        <div className="panel-body has-rule stack gap-2">
          <h3>{G.groups.intent.confirmed}</h3>
          <Md source={confirmed} level={4} anchor="phase-intent" />
        </div>
      ) : null}
    </section>
  );
}

// -- the side --------------------------------------------------------------------------------------

/** The phase's agenda item: one row, its state, and F45's mark in its end cell. */
export function PhaseAgendaItem({
  item,
  href,
}: {
  item: PhaseItemView;
  href: string;
}) {
  return (
    <section className="panel" aria-labelledby="phase-item-head">
      <div className="panel-head">
        <h2 id="phase-item-head">{G.heads.agendaItem}</h2>
      </div>
      <WsList>
        <WsRow
          id={item.id}
          name={item.title}
          href={href}
          lang={item.lang === "ko" ? "ko" : null}
          status={item.state}
          end={
            item.mark ? (
              <span className="ws-end">
                {item.mark === "waiting" ? <WaitingBadge /> : <RefusedBadge />}
              </span>
            ) : undefined
          }
        />
      </WsList>
    </section>
  );
}

export function PhaseReview({ review }: { review: Phase["review"] }) {
  return (
    <section className="panel" aria-labelledby="phase-review-head">
      <div className="panel-head">
        <h2 id="phase-review-head">{G.heads.review}</h2>
        <WsStatus kind="verdict" value={review.verdict} />
      </div>
      {review.note ? (
        <div className="panel-body has-rule">
          <p className="phase-md">
            <WsProse text={review.note} />
          </p>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Explained in (`Phase.dc.html`): one row a document the phase is explained in (`explainedDocuments`), its
 * title as a link to the document in the Library's reader, `Library` under it. No rows, no panel.
 */
export function PhaseExplained({
  documents,
}: {
  documents: readonly ExplainedRow[];
}) {
  if (documents.length === 0) return null;
  return (
    <section className="panel" aria-labelledby="phase-doc-head">
      <div className="panel-head">
        <h2 id="phase-doc-head">{G.heads.explainedIn}</h2>
      </div>
      <ul className="ws-list">
        {documents.map((d) => (
          <li key={d.key} className="row phase-link-row">
            <Link className="link-strong ws-open" href={d.href}>
              <span className="row-stack">
                <span
                  className="ws-name-text"
                  lang={HANGUL.test(d.title) ? "ko" : undefined}
                >
                  {d.title}
                </span>
                <span className="meta ws-sub">{PHASE_PAGE.library}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// -- the page --------------------------------------------------------------------------------------

export interface PhaseLinks {
  slice: (full: string) => string;
  item: (id: string) => string;
}

/** A phase (`Phase.dc.html`): the head, then the main column and the side column. */
export function PhaseView({
  phase,
  back,
  line,
  item,
  links,
  dates,
}: {
  phase: Phase;
  back: WsBack;
  line: WsSyncLine;
  item: PhaseItemView | null;
  links: PhaseLinks;
  dates: Dates;
}) {
  const place = gatePlace(phase.gate);
  const name = phase.name ?? "";
  return (
    <div className="column">
      <ItemHead
        back={back}
        line={line}
        id={phase.id}
        name={name}
        lang={name && HANGUL.test(name) ? "ko" : null}
        status={wsStatus("phase", phase.status)}
        after={
          <Steps
            done={phase.done}
            total={phase.total}
            live={phase.status === "in_progress" && phase.done < phase.total}
            compact
            n={Math.max(1, phase.total)}
            className="phase-progress"
          />
        }
      >
        <div className="stack gap-4">
          {phase.objective ? (
            <p className="phase-text ws-prose">
              <WsProse text={phase.objective} />
            </p>
          ) : null}
          <Facts>
            <Fact label={L.created}>{dates.date(phase.created)}</Fact>
            <Fact label={L.started}>{dates.date(phase.started)}</Fact>
            <Fact label={L.completed}>{dates.date(phase.completed)}</Fact>
            {phase.branches.map((b, i) => (
              <BranchFact key={`${b.repo}-${b.branch}-${i}`} branch={b} />
            ))}
          </Facts>
        </div>
      </ItemHead>
      <div className="sidebar">
        <div className="main stack gap-5">
          {place === "main" ? (
            <PhaseGate gate={phase.gate} date={dates.date} />
          ) : null}
          <PhaseSlices
            slices={phase.slices}
            current={phase.current}
            asked={askedDates(phase, dates.date)}
            href={links.slice}
          />
          {phase.notebook ? <PhaseNotebook notebook={phase.notebook} /> : null}
          <PhaseIntent intent={phase.intent} />
        </div>
        <div className="side stack gap-5">
          {item ? (
            <PhaseAgendaItem item={item} href={links.item(item.id)} />
          ) : null}
          <PhaseReview review={phase.review} />
          {place === "side" ? (
            <PhaseGate gate={phase.gate} date={dates.date} />
          ) : null}
          <PhaseExplained documents={explainedDocuments(phase)} />
        </div>
      </div>
    </div>
  );
}
