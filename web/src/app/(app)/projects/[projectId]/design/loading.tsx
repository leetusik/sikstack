import { DESIGN } from "@/content/design";
import { Skeleton } from "@/sikstack/ui";

/**
 * The Design list and a build's viewer while they load (P77, not a designed state): the list's head and one
 * panel of three skeleton rows, so the project home's loading form never shows under Design.
 */
export default function DesignLoading() {
  return (
    <div className="column" aria-busy="true">
      <header className="page-top">
        <div className="page-head">
          <h1>{DESIGN.title}</h1>
        </div>
      </header>
      <section className="panel">
        {[0, 1, 2].map((i) => (
          <div key={i} className="row">
            <Skeleton width="12em" />
          </div>
        ))}
        <span className="sr-only">Loading…</span>
      </section>
    </div>
  );
}
