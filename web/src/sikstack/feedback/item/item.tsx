import Link from "next/link";
import type { ReactNode } from "react";

import {
  DOWNLOAD,
  EMPTY,
  FEEDBACK,
  FILE_COLUMNS,
  LABELS,
  PARTS,
} from "@/content/feedback-frame";
import { ACTION, LOADING, MESSAGE } from "@/content/feedback-item";

import { Fact, Facts, Json, KeepLines } from "../facts";
import { Rating, Tags } from "../marks";
import { FACT_LABELS, type FeedbackItemView, type ItemFact } from "./model";

/**
 * One piece of feedback (`FeedbackItem.dc.html`; `result.md` § One piece of feedback; frame.md F121 to
 * F127, F142), in the main column, top to bottom: the way back, the head (title, rating, the captured
 * time, then the head's end), the message, Comment, the Agenda part's place, Details, Operator
 * comments, Attachments. Presentational: the view comes from `feedbackItemView`, the way back from
 * `feedbackBackHref`.
 *
 * The two slots are P65-nh.S6's (Add to agenda and the Agenda part): `headEnd` sits at the head's end
 * (`.fi-head`, after `.page-title`), `agenda` between Comment and Details. Both render nothing unless
 * given; they are filled in one place only, `./body.tsx`.
 *
 * The third slot, `state` (P91-v3, applied from S3's signed design): the state line (`ItemStateLine`), under the
 * title's line inside `.page-title`; the state's actions join the head's end, before Add to agenda (`./body.tsx`
 * fills both).
 */
export function FeedbackItem({
  view,
  backHref,
  headEnd = null,
  agenda = null,
  state = null,
}: {
  view: FeedbackItemView;
  backHref: string;
  /** The head's end: Add to agenda, or what took its place (S6). */
  headEnd?: ReactNode;
  /** The Agenda part, between Comment and Details (S6). */
  agenda?: ReactNode;
  /** The state line, under the title's line (P91-v3). */
  state?: ReactNode;
}) {
  return (
    <div className="column">
      <header className="page-top">
        <Link className="back" href={backHref}>
          {FEEDBACK}
        </Link>
        <div className="page-head fi-head">
          <div className="page-title">
            <h1>{view.title}</h1>
            <p className="cluster baseline gap-3">
              <Rating value={view.value} />
              <time className="dim" dateTime={view.iso}>
                {view.when}
              </time>
            </p>
            {state}
          </div>
          {headEnd}
        </div>
      </header>
      <section className="panel" aria-label={MESSAGE}>
        <div className="panel-body">
          <KeepLines text={view.message} lead lang={view.lang} />
        </div>
      </section>
      <section className="panel" aria-label={PARTS.comment}>
        <div className="panel-head">
          <h2>{PARTS.comment}</h2>
        </div>
        {view.comment ? (
          <div className="panel-body has-rule">
            <KeepLines text={view.comment.text} lang={view.comment.lang} />
          </div>
        ) : (
          <div className="panel-body has-rule block">
            <p className="block-text">{EMPTY.comment}</p>
          </div>
        )}
      </section>
      {agenda}
      <section className="panel" aria-label={PARTS.details}>
        <div className="panel-head">
          <h2>{PARTS.details}</h2>
          <p className="meta">{view.zone}</p>
        </div>
        <div className="panel-body has-rule">
          <Facts>
            {view.facts.map((fact) => (
              <Fact key={fact.key} label={fact.label}>
                {factValue(fact)}
              </Fact>
            ))}
            {view.longs.map((long) => (
              <Fact key={long.key} label={long.label} wide>
                <KeepLines text={long.text} lang={long.lang} />
              </Fact>
            ))}
            <Fact label={LABELS.tags} wide>
              <Tags tags={view.tags} />
            </Fact>
            {view.raws.map((raw) => (
              <Fact key={raw.key} label={raw.label} wide>
                <Json label={raw.label} value={raw.value} />
              </Fact>
            ))}
          </Facts>
        </div>
      </section>
      <ItemComments view={view} />
      <ItemFiles view={view} />
    </div>
  );
}

/** A fact's value; none for the dash, which `Fact` draws for an empty value (F124). */
function factValue(fact: ItemFact): ReactNode {
  switch (fact.kind) {
    case "text":
      return fact.text;
    case "rating":
      return <Rating value={fact.value} />;
    case "time":
      return <time dateTime={fact.iso}>{fact.text}</time>;
    default:
      return null;
  }
}

/** Operator comments (`FeedbackItemComments.dc.html`): the count, oldest first, or the empty sentence. */
function ItemComments({ view }: { view: FeedbackItemView }) {
  return (
    <section className="panel" aria-label={PARTS.operatorComments}>
      <div className="panel-head">
        <h2>{PARTS.operatorComments}</h2>
        {view.commentCount ? <p className="meta">{view.commentCount}</p> : null}
      </div>
      {view.comments.length > 0 ? (
        <ul>
          {view.comments.map((c) => (
            <li key={c.id} className="fi-comment">
              <p className="cluster baseline">
                <span className={c.unknown ? "strong dim" : "strong"}>
                  {c.author}
                </span>
                <time className="dim" dateTime={c.iso}>
                  {c.when}
                </time>
              </p>
              <KeepLines text={c.body} lang={c.lang} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="panel-body has-rule block">
          <p className="block-text">{EMPTY.operatorComments}</p>
        </div>
      )}
    </section>
  );
}

function FilesHead() {
  return (
    <thead>
      <tr>
        <th scope="col">{FILE_COLUMNS.file}</th>
        <th scope="col">{FILE_COLUMNS.type}</th>
        <th scope="col" className="num">
          {FILE_COLUMNS.size}
        </th>
        <th scope="col" className="at-end">
          <span className="sr-only">{ACTION}</span>
        </th>
      </tr>
    </thead>
  );
}

/**
 * Attachments (`FeedbackItemFiles.dc.html`): the table that stacks with its set columns (`.fi-files`),
 * or the empty sentence. Download is a link to the web app's relay, which forces the download; it is
 * drawn as the board's quiet button and named `Download <file name>`.
 */
function ItemFiles({ view }: { view: FeedbackItemView }) {
  return (
    <section className="panel" aria-label={PARTS.attachments}>
      <div className="panel-head">
        <h2>{PARTS.attachments}</h2>
        {view.fileCount ? <p className="meta">{view.fileCount}</p> : null}
      </div>
      {view.files.length > 0 ? (
        <div className="table-scroll table-stack">
          <table className="fi-files table">
            <FilesHead />
            <tbody>
              {view.files.map((f) => (
                <tr key={f.id}>
                  <td className="is-main">
                    <span className={f.untitled ? "strong dim" : "strong"}>
                      {f.name}
                    </span>
                  </td>
                  <td className="fi-type">{f.type}</td>
                  <td className="num">{f.size}</td>
                  <td className="at-end to-end">
                    <a
                      className="btn btn-quiet fi-get"
                      href={f.href}
                      download={f.filename}
                      aria-label={f.label}
                    >
                      {DOWNLOAD}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="panel-body has-rule block">
          <p className="block-text">{EMPTY.attachments}</p>
        </div>
      )}
    </section>
  );
}

const skel = (width: string) => <span className="skel" style={{ width }} />;

/**
 * The page while it loads (`FeedbackItem.dc.html`, Loading; F132, F141): the way back; a bar in the
 * `h1`, the message and Comment; Details' head and its fifteen labels over bars; Operator comments and
 * Attachments under their heads over one skeleton row. No add and no Agenda part.
 */
export function FeedbackItemLoading({
  backHref,
  zone,
}: {
  backHref: string;
  zone: string;
}) {
  return (
    <div className="column">
      <header className="page-top">
        <Link className="back" href={backHref}>
          {FEEDBACK}
        </Link>
        <div className="page-head fi-head">
          <div className="page-title">
            <h1 aria-busy="true">
              {skel("9em")}
              <span className="sr-only">{LOADING}</span>
            </h1>
          </div>
        </div>
      </header>
      <section className="panel" aria-label={MESSAGE} aria-busy="true">
        <div className="panel-body">
          <p className="lead">{skel("26em")}</p>
        </div>
      </section>
      <section className="panel" aria-label={PARTS.comment} aria-busy="true">
        <div className="panel-head">
          <h2>{PARTS.comment}</h2>
        </div>
        <div className="panel-body has-rule">
          <p>{skel("20em")}</p>
        </div>
      </section>
      <section className="panel" aria-label={PARTS.details} aria-busy="true">
        <div className="panel-head">
          <h2>{PARTS.details}</h2>
          <p className="meta">{zone}</p>
        </div>
        <div className="panel-body has-rule">
          <Facts>
            {FACT_LABELS.map((label) => (
              <div key={label} className="fact">
                <dt>{label}</dt>
                <dd>{skel("6em")}</dd>
              </div>
            ))}
          </Facts>
        </div>
      </section>
      <section
        className="panel"
        aria-label={PARTS.operatorComments}
        aria-busy="true"
      >
        <div className="panel-head">
          <h2>{PARTS.operatorComments}</h2>
        </div>
        <ul>
          <li className="fi-comment">
            <p>{skel("7em")}</p>
            <p>{skel("22em")}</p>
          </li>
        </ul>
        <span className="sr-only">{LOADING}</span>
      </section>
      <section
        className="panel"
        aria-label={PARTS.attachments}
        aria-busy="true"
      >
        <div className="panel-head">
          <h2>{PARTS.attachments}</h2>
        </div>
        <div className="table-scroll table-stack">
          <table className="fi-files table">
            <FilesHead />
            <tbody>
              <tr>
                <td className="is-main">{skel("9em")}</td>
                <td className="fi-type">{skel("5em")}</td>
                <td className="num">{skel("4em")}</td>
                <td className="at-end to-end">
                  <span className="fi-get-skel">
                    <span className="skel" />
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <span className="sr-only">{LOADING}</span>
      </section>
    </div>
  );
}
