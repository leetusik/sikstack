import type { Metadata } from "next";

import { Badge, Panel, UiRoot } from "@/sikstack/ui";

import { DESIGN } from "../next/content/design";
import { shortCommit } from "../next/design/model";

import css from "../lib/index.module.css";
import { DESIGN_MARK } from "../lib/mark";
import { buildSource, optionsPage, PAGES } from "../lib/pages";

// The design build's front page, where a share link lands: every page of the build (`lib/pages.ts`, the list the
// manifest is written from), and under each its states (`lib/page-states.ts`) as links, `?state=<key>` each.
const source = buildSource();
const title = source ? DESIGN.buildTitle(shortCommit(source.commit) ?? source.commit) : "Design build";

export const metadata: Metadata = { title };

function Row({
  name,
  route,
  entry,
  links,
}: {
  name: string;
  route: string;
  entry: string;
  links: { key: string; label: string; href: string }[];
}) {
  return (
    <li className="row">
      <div className={css.head}>
        <a className="link-strong" href={entry}>
          {name}
        </a>
        <span className={`mono meta ${css.route}`}>{route}</span>
      </div>
      {links.length > 0 ? (
        <ul className={css.states} aria-label={name}>
          {links.map((l) => (
            <li key={l.key}>
              <a className="link-row" href={l.href}>
                {l.label}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default function DesignIndex() {
  const options = optionsPage();
  return (
    <UiRoot data-design={DESIGN_MARK}>
      <div className="page">
        <div className="app">
          <main id="main-content" className="app-main">
            <div className="column">
              <div className="page-head">
                <div className="page-title">
                  <h1>{title}</h1>
                  {source?.dirty ? <Badge>{DESIGN.dirty}</Badge> : null}
                </div>
              </div>
              <Panel>
                <ul className={css.pages}>
                  {options ? (
                    <Row
                      name={options.name ?? DESIGN.options.title}
                      route={options.entry}
                      entry={options.entry}
                      links={options.directions.map((d) => ({ key: d.key, label: d.label, href: d.entry }))}
                    />
                  ) : null}
                  {PAGES.map((p) => (
                    <Row
                      key={p.entry}
                      name={p.name}
                      route={p.route}
                      entry={p.entry}
                      links={(p.states?.list ?? []).map((s) => ({
                        key: s.key,
                        label: s.label,
                        href: `${p.entry}?state=${encodeURIComponent(s.key)}`,
                      }))}
                    />
                  ))}
                </ul>
              </Panel>
            </div>
          </main>
        </div>
      </div>
    </UiRoot>
  );
}
