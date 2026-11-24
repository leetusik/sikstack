import Link from "next/link";

import { WS_DOCS } from "@/content/workspace/docs";
import { WS_GLOSSARY } from "@/content/workspace/frame";
import { Fact } from "@/sikstack/workspace/frame/facts";
import type { WsBack } from "@/sikstack/workspace/frame/states-model";
import { WsRetrySync, WsSync } from "@/sikstack/workspace/frame/sync";
import {
  NO_LINE,
  type WsSyncLine,
} from "@/sikstack/workspace/frame/sync-model";

// A doc's first row and its loading form: no Markdown here, so a loading boundary (a client component) can draw
// them without the renderer.

/**
 * A doc's first row (F35, F84): the way back, reading its destination's name (**Docs**, or the doc's title from an
 * earlier version), and the sync line at its end in every state. With no sync facts to show (the page's reads
 * failed) the row holds the way back alone, and the line's bar while Try again reads the page again.
 */
export function DocBackRow({
  back,
  ariaLabel,
  lang,
  line,
  loading = false,
}: {
  back: WsBack;
  ariaLabel?: string;
  lang?: string;
  line: WsSyncLine | null;
  loading?: boolean;
}) {
  return (
    <div className="ws-top">
      <Link className="back" href={back.href} aria-label={ariaLabel}>
        {lang === "ko" ? <span lang="ko">{back.label}</span> : back.label}
      </Link>
      {line || loading ? (
        <WsSync line={line ?? NO_LINE} loading={loading} />
      ) : (
        <WsRetrySync />
      )}
    </div>
  );
}

const TEXT_BARS = ["9em", "34em", "30em", "12em", "32em", "22em"];

/**
 * A doc while it loads (`Docs.dc.html`, Doc loading): the back row with the sync line as a bar, the `h1` a bar, the
 * three facts with bars for values, panel **Text** with six bars.
 */
export function DocLoading({ back }: { back: WsBack }) {
  const { labels } = WS_GLOSSARY;
  return (
    <>
      <header className="page-top">
        <DocBackRow
          back={back}
          ariaLabel={WS_DOCS.backTo(back.label)}
          line={null}
          loading
        />
        <div className="page-head ws-head" aria-busy="true">
          <div className="page-title">
            <h1>
              <span className="skel" style={{ width: "7em" }} />
              <span className="sr-only">{WS_DOCS.loading}</span>
            </h1>
          </div>
        </div>
      </header>
      <dl className="facts" aria-busy="true">
        <Fact label={labels.doc.version}>
          <span className="skel" style={{ width: "2em" }} />
        </Fact>
        <Fact label={labels.doc.versioned}>
          <span className="skel" style={{ width: "3em" }} />
        </Fact>
        <Fact label={labels.doc.from}>
          <span className="skel" style={{ width: "9em" }} />
        </Fact>
      </dl>
      <section
        className="panel"
        aria-labelledby="docs-text-head"
        aria-busy="true"
      >
        <div className="panel-head">
          <h2 id="docs-text-head">{WS_GLOSSARY.heads.text}</h2>
        </div>
        <div className="panel-body has-rule">
          <div className="stack docs-wait-text gap-3">
            {TEXT_BARS.map((w, i) => (
              <span key={i}>
                <span className="skel" style={{ width: w }} />
              </span>
            ))}
          </div>
          <span className="sr-only">{WS_DOCS.loading}</span>
        </div>
      </section>
    </>
  );
}
