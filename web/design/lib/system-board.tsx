"use client";

/**
 * The system page's board (`/system/`): the product's tokens (parsed from `tokens.css` by the page) and every
 * shared component exported by `@/sikstack/{ui,frame,states,shell}`, drawn by the real components, side by side,
 * in each state their props allow. A cell names its component(s) (`data-component`) and the props that make the
 * state (`data-state`); an export that is not a component (a function, a constant, a hook) is listed at the end
 * with what draws it (`data-export`). `design/scripts/build.mjs` fails when an export is in neither, or when the
 * page's token list differs from the file's. States a component reaches only by a click (an open menu, the Keys
 * form) are not props, so they are not here; a dialog is drawn open in place.
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

import {
  Copy,
  DeleteDialog,
  Dialog,
  DialogActions,
  Keys,
  Trend,
  Usage,
  type DialogProps,
  type KeyRow,
} from "@/sikstack/frame";
import {
  LegacyPage,
  publishToast,
  Shell,
  ShellOrgNameProvider,
  ToastRegion,
  type ShellOrg,
  type ShellProject,
} from "@/sikstack/shell";
import {
  errorState,
  notFoundState,
  StateBlock,
  useShellOrgName,
} from "@/sikstack/states";
import {
  Badge,
  Block,
  BlockText,
  BlockTitle,
  Button,
  ButtonLink,
  Center,
  Check,
  Cluster,
  Count,
  Field,
  FieldError,
  FieldSet,
  FormRow,
  Grid,
  Grow,
  Hint,
  Ico,
  Input,
  Label,
  Legacy,
  Legend,
  Meter,
  Notice,
  Panel,
  PanelBody,
  PanelFoot,
  PanelHead,
  Say,
  Section,
  SectionHead,
  Sidebar,
  SidebarMain,
  SidebarSide,
  Skeleton,
  Split,
  Stack,
  Stat,
  Stats,
  Status,
  Swap,
  Table,
  Textarea,
  UiRoot,
  type ButtonVariant,
  type IcoName,
  type StatusState,
} from "@/sikstack/ui";

import { DESIGN_MARK } from "./mark";
import { PROJECT, RECORDING } from "./recording";
import css from "./system.module.css";
import type { Token, TokenGroup, TokenSheet } from "./tokens";

// -- the board's frame ------------------------------------------------------------------------------

function Cell({
  component,
  state,
  wide = false,
  children,
}: {
  /** The exported name(s) the cell draws, space-separated. */
  component: string;
  /** The props that make the state, as code. */
  state: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <figure
      className={wide ? `${css.cell} ${css.wide}` : css.cell}
      data-component={component}
      data-state={state}
      style={{ margin: 0 }}
    >
      <figcaption className={css.label}>
        <strong>{component.split(" ").join(" · ")}</strong>
        <code className={css.code}>{state}</code>
      </figcaption>
      <div className={css.stage}>{children}</div>
    </figure>
  );
}

function Part({ id, title, note, children }: { id: string; title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className={css.part} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className={css.partTitle}>
        {title}
      </h2>
      {note ? <p className={css.note}>{note}</p> : null}
      {children}
    </section>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h3 className={css.groupTitle}>{title}</h3>
      <div className={css.grid}>{children}</div>
    </>
  );
}

// -- tokens ----------------------------------------------------------------------------------------

const SCHEME_TITLE = { light: "Light roles", dark: "Dark roles", sepia: "Sepia roles (the reader)" } as const;

function Swatch({ token }: { token: Token }) {
  return (
    <div className={css.swatch} data-token={token.name} data-value={token.value}>
      {token.kind === "shadow" ? (
        <div className={css.shadowChip} style={{ boxShadow: `var(${token.name})` }} />
      ) : (
        <div className={css.chip} style={{ background: `var(${token.name})` }} />
      )}
      <code className={css.code}>{token.name}</code>
      <code className={css.code}>{token.value}</code>
    </div>
  );
}

function SchemeGroup({ group }: { group: TokenGroup }) {
  const scheme = group.scheme ?? "light";
  return (
    <div className={css.scheme} data-scheme={scheme}>
      <h3 className={css.groupTitle} style={{ margin: 0 }}>
        {SCHEME_TITLE[scheme]}
      </h3>
      <p className={css.note}>
        <code className={css.code}>{group.selector}</code>
        {group.other.map((o) => (
          <span key={o.name}>
            {" "}
            · <code className={css.code}>{`${o.name}: ${o.value}`}</code>
          </span>
        ))}
      </p>
      <div className={css.swatches}>
        {group.tokens.map((t) => (
          <Swatch key={t.name} token={t} />
        ))}
      </div>
    </div>
  );
}

function ScaleRow({ token }: { token: Token }) {
  let sample: ReactNode;
  switch (token.kind) {
    case "space":
      sample = <div className={css.bar} style={{ width: `var(${token.name})` }} />;
      break;
    case "radius":
      sample = <div className={css.radiusChip} style={{ borderRadius: `var(${token.name})` }} />;
      break;
    case "size":
      sample = (
        <p className={css.specimen} style={{ fontSize: `var(${token.name})` }}>
          Agenda, 아젠다 1,284
        </p>
      );
      break;
    case "line":
      sample = (
        <p
          className={css.specimen}
          style={{ lineHeight: `var(${token.name})`, background: "var(--accent-tint)", maxWidth: "16em" }}
        >
          Two lines at this height, so the leading shows between them.
        </p>
      );
      break;
    case "font":
      sample = (
        <p className={css.specimen} style={{ fontFamily: `var(${token.name})`, fontSize: 16 }}>
          The quick brown fox 0123456789 다람쥐 헌 쳇바퀴
        </p>
      );
      break;
    case "shadow":
      sample = <div className={css.shadowChip} style={{ boxShadow: `var(${token.name})` }} />;
      break;
    default:
      sample = <div className={css.chip} style={{ background: `var(${token.name})` }} />;
  }
  return (
    <div className={css.row} data-token={token.name} data-value={token.value}>
      <code className={css.code}>{token.name}</code>
      <code className={css.code}>{token.value}</code>
      <div>{sample}</div>
    </div>
  );
}

const SCALE_TITLE: Record<string, string> = {
  space: "Space",
  radius: "Radius",
  size: "Type sizes",
  line: "Line heights",
  font: "Font stacks",
  shadow: "Shadow",
  colour: "Colour",
  other: "Other",
};

function ScaleGroup({ group }: { group: TokenGroup }) {
  // The file's runs, in its order: space, radius, sizes, line heights, fonts.
  const runs: { kind: string; tokens: Token[] }[] = [];
  for (const t of group.tokens) {
    const last = runs[runs.length - 1];
    if (last && last.kind === t.kind) last.tokens.push(t);
    else runs.push({ kind: t.kind, tokens: [t] });
  }
  return (
    <>
      <p className={css.note}>
        <code className={css.code}>{group.selector}</code>
      </p>
      {runs.map((run) => (
        <div key={run.kind} className={css.rows}>
          <h3 className={css.groupTitle}>{SCALE_TITLE[run.kind]}</h3>
          {run.tokens.map((t) => (
            <ScaleRow key={t.name} token={t} />
          ))}
        </div>
      ))}
    </>
  );
}

function Tokens({ sheet, source }: { sheet: TokenSheet; source: string }) {
  const count = new Set(sheet.groups.flatMap((g) => g.tokens.map((t) => t.name))).size;
  return (
    <Part
      id="tokens"
      title="Tokens"
      note={
        <>
          Every custom property in <code className={css.code}>{source}</code> ({count} names), grouped as the file
          groups them, read from the file when the design builds. Each sample paints with the token itself.
        </>
      }
    >
      {sheet.groups
        .filter((g) => g.scheme !== null)
        .map((g) => (
          <SchemeGroup key={g.selector} group={g} />
        ))}
      {sheet.groups
        .filter((g) => g.scheme === null)
        .map((g) => (
          <ScaleGroup key={g.selector} group={g} />
        ))}
      <div className={css.rows}>
        <h3 className={css.groupTitle}>Type classes</h3>
        {sheet.typeClasses.map((c) => (
          <div key={c.name} className={css.row} data-type-class={c.name}>
            <code className={css.code}>.{c.name}</code>
            <code className={css.code}>
              {c.declarations
                .filter((d) => d.name !== "font-family")
                .map((d) => d.value)
                .join(" / ")}
            </code>
            <p className={`${c.name} ${css.specimen}`}>Agenda item 아젠다 1,284</p>
          </div>
        ))}
      </div>
    </Part>
  );
}

// -- ui --------------------------------------------------------------------------------------------

const VARIANTS: ButtonVariant[] = ["default", "primary", "quiet", "danger"];
const STATUSES: StatusState[] = ["active", "idle", "live", "revoked", "done", "busy", "fail"];
const ICOS: IcoName[] = ["play", "pause", "prev", "next", "again", "up"];
const v = (variant: ButtonVariant) => (variant === "default" ? "" : `variant="${variant}" `);

function UiParts() {
  return (
    <Part
      id="ui"
      title="@/sikstack/ui"
      note="The typed primitives. Every state below is a prop; the words are the caller's."
    >
      <Group title="Button, ButtonLink, Swap">
        {VARIANTS.map((variant) => (
          <Cell key={variant} component="Button" state={`${v(variant)}· rest, disabled, busy, busy + busyLabel`}>
            <Cluster>
              <Button variant={variant}>Save</Button>
              <Button variant={variant} disabled>
                Save
              </Button>
              <Button variant={variant} busy>
                Save
              </Button>
              <Button variant={variant} busy busyLabel="Saving…">
                Save
              </Button>
            </Cluster>
          </Cell>
        ))}
        <Cell component="ButtonLink" state='variant="default" | "primary" | "quiet" | "danger"'>
          <Cluster>
            {VARIANTS.map((variant) => (
              <ButtonLink key={variant} variant={variant} href="#ui">
                Open
              </ButtonLink>
            ))}
          </Cluster>
        </Cell>
        <Cell component="Swap" state='labels={["Copy", "Copied"]} · first, then under data-swap'>
          <Cluster>
            <span className="btn">
              <Swap labels={["Copy", "Copied"]} />
            </span>
            <span className="btn" data-swap="true">
              <Swap labels={["Copy", "Copied"]} />
            </span>
          </Cluster>
        </Cell>
      </Group>

      <Group title="Marks">
        <Cell component="Badge" state="children">
          <Cluster>
            <Badge>Private</Badge>
            <Badge>Public</Badge>
          </Cluster>
        </Cell>
        <Cell component="Count" state="children (due())">
          <Cluster>
            <Count>3</Count>
            <Count>99+</Count>
          </Cluster>
        </Cell>
        <Cell component="Status" state={`state=${STATUSES.map((s) => `"${s}"`).join(" | ")}`}>
          <Stack gap={2}>
            {STATUSES.map((s) => (
              <Status key={s} state={s}>
                {s}
              </Status>
            ))}
          </Stack>
        </Cell>
        <Cell component="Say" state='as="p" | "span" · state · rest or none'>
          <Stack gap={2}>
            <Say word="Ready" rest="· 12 chapters" />
            <Say state="busy" word="Preparing" rest="· chapter 3 of 12" />
            <Say state="fail" word="Failed" rest="· try again" />
            <Say state="done" word="Done" />
            <Button>
              <Say as="span" state="live" word="Listening" />
            </Button>
          </Stack>
        </Cell>
        <Cell component="Ico" state={`name=${ICOS.map((n) => `"${n}"`).join(" | ")}`}>
          <Cluster>
            {ICOS.map((n) => (
              <Button key={n}>
                <Ico name={n} />
                {n}
              </Button>
            ))}
          </Cluster>
        </Cell>
        <Cell component="Meter" state="value 0 | 40 | 100 · bare, label">
          <Stack gap={3}>
            <Meter value={0} />
            <Meter value={40} />
            <Meter value={100} />
            <Meter value={40} label="Audio prepared" />
          </Stack>
        </Cell>
      </Group>

      <Group title="Surfaces">
        <Cell component="Panel PanelHead PanelBody PanelFoot" state="PanelBody rule={false} | rule">
          <Stack gap={4}>
            <Panel>
              <PanelHead>
                <h2>Projects</h2>
                <Button>New project</Button>
              </PanelHead>
              <PanelBody>
                <p>A body without the rule.</p>
              </PanelBody>
            </Panel>
            <Panel>
              <PanelHead>
                <h2>Keys</h2>
                <p className="meta">3</p>
              </PanelHead>
              <PanelBody rule>
                <p>A body with the rule under the head.</p>
              </PanelBody>
              <PanelFoot>
                <a className="link-row" href="#ui">
                  All keys
                </a>
              </PanelFoot>
            </Panel>
          </Stack>
        </Cell>
        <Cell component="Section SectionHead" state="children">
          <Section>
            <SectionHead>
              <h2>Recent</h2>
              <p className="meta">Updated 4m ago</p>
            </SectionHead>
            <p>Parts of a page under a heading, no surface.</p>
          </Section>
        </Cell>
        <Cell component="Block BlockText BlockTitle" state="page={false} (in a panel) | page">
          <Stack gap={4}>
            <Panel>
              <PanelHead>
                <h2>Documents</h2>
              </PanelHead>
              <Block className="panel-body has-rule">
                <BlockText>No documents yet.</BlockText>
              </Block>
            </Panel>
            <Block page>
              <BlockTitle>Nothing here</BlockTitle>
              <BlockText>A whole page&apos;s block, its title on a page title&apos;s line.</BlockText>
              <Button variant="primary">Go back</Button>
            </Block>
          </Stack>
        </Cell>
        <Cell component="Table" state="default · capped · keys" wide>
          <Stack gap={4}>
            <SampleTable />
            <SampleTable capped rows={12} />
            <SampleTable keys />
          </Stack>
        </Cell>
      </Group>

      <Group title="Fields">
        <Cell component="Field Label Input Hint" state="rest · disabled">
          <Stack gap={4}>
            <Field>
              <Label htmlFor="sys-name">Project name</Label>
              <Input id="sys-name" defaultValue="changple" aria-describedby="sys-name-hint" />
              <Hint id="sys-name-hint">Lowercase letters and dashes.</Hint>
            </Field>
            <Field>
              <Label htmlFor="sys-off">Disabled</Label>
              <Input id="sys-off" defaultValue="Can't edit" disabled />
            </Field>
          </Stack>
        </Cell>
        <Cell component="FieldError" state='with aria-invalid="true" on the input'>
          <Field>
            <Label htmlFor="sys-bad">Key name</Label>
            <Input id="sys-bad" defaultValue="x" aria-invalid="true" aria-describedby="sys-bad-error" />
            <FieldError id="sys-bad-error">Use 200 characters or fewer.</FieldError>
          </Field>
        </Cell>
        <Cell component="Textarea" state="rest · disabled">
          <Stack gap={3}>
            <Field>
              <Label htmlFor="sys-note">Note</Label>
              <Textarea id="sys-note" rows={3} defaultValue="A longer note, on more than one line." />
            </Field>
            <Textarea aria-label="Disabled note" rows={2} defaultValue="Disabled" disabled />
          </Stack>
        </Cell>
        <Cell component="FieldSet Legend Check" state="checkbox · radio · checked · disabled">
          <FieldSet>
            <Legend>Access</Legend>
            <Cluster gap={4}>
              <Check>
                <input type="radio" name="sys-access" defaultChecked /> Full access
              </Check>
              <Check>
                <input type="radio" name="sys-access" /> Capture only
              </Check>
              <Check>
                <input type="checkbox" defaultChecked /> Remember
              </Check>
              <Check>
                <input type="checkbox" disabled /> Disabled
              </Check>
            </Cluster>
          </FieldSet>
        </Cell>
        <Cell component="FormRow" state="fields and their button on one line">
          <FormRow onSubmit={(e) => e.preventDefault()}>
            <Field>
              <Label htmlFor="sys-find">Find</Label>
              <Input id="sys-find" type="search" placeholder="Title" />
            </Field>
            <Button type="submit" variant="primary">
              Search
            </Button>
          </FormRow>
        </Cell>
        <Cell component="Notice" state="danger={false} | danger">
          <Stack gap={3}>
            <Notice>Changes are saved as you type.</Notice>
            <Notice danger role="alert">
              Could not create the key. Try again.
            </Notice>
          </Stack>
        </Cell>
      </Group>

      <Group title="Read-outs">
        <Cell component="Stats Stat" state="figure · loading (Skeleton)">
          <Stack gap={4}>
            <Stats>
              <Stat label="Documents">1,284</Stat>
              <Stat label="Searches">312</Stat>
            </Stats>
            <Stats aria-busy="true">
              <Stat label="Documents">
                <Skeleton width="3em" />
              </Stat>
              <Stat label="Searches">
                <Skeleton width="3em" />
              </Stat>
            </Stats>
          </Stack>
        </Cell>
        <Cell component="Skeleton" state="default · width · plot">
          <Stack gap={3}>
            <p>
              <Skeleton />
            </p>
            <p>
              <Skeleton width="8em" />
            </p>
            <Skeleton plot />
          </Stack>
        </Cell>
      </Group>

      <Group title="Layout">
        <Cell component="Stack" state="gap 1…7">
          <Cluster topAligned>
            {([1, 3, 5, 7] as const).map((g) => (
              <Stack key={g} gap={g}>
                <Badge>gap {g}</Badge>
                <Badge>b</Badge>
                <Badge>c</Badge>
              </Stack>
            ))}
          </Cluster>
        </Cell>
        <Cell component="Cluster" state="default · baseline · topAligned · toEnd">
          <Stack gap={3}>
            <Cluster>
              <Badge>one</Badge>
              <Badge>two</Badge>
              <Button>three</Button>
            </Cluster>
            <Cluster baseline>
              <h3 style={{ margin: 0 }}>Title</h3>
              <span className="meta">baseline</span>
            </Cluster>
            <Cluster topAligned>
              <Button>tall</Button>
              <span className="meta">topAligned</span>
            </Cluster>
            <Cluster toEnd>
              <Button>Cancel</Button>
              <Button variant="primary">toEnd</Button>
            </Cluster>
          </Stack>
        </Cell>
        <Cell component="Split Grow" state="split, grow taking the room">
          <Split>
            <Grow>
              <span className="meta">Grow takes the room left</span>
            </Grow>
            <Button>End</Button>
          </Split>
        </Cell>
        <Cell component="Sidebar SidebarSide SidebarMain" state="side and main">
          <Sidebar>
            <SidebarSide>
              <Badge>side</Badge>
            </SidebarSide>
            <SidebarMain>
              <p>The main part, beside its side until the room runs out.</p>
            </SidebarMain>
          </Sidebar>
        </Cell>
        <Cell component="Center" state="children">
          <Center>
            <Badge>centred</Badge>
          </Center>
        </Cell>
        <Cell component="Grid" state='default · min="8em"'>
          <Stack gap={3}>
            <Grid gap={2}>
              <Badge>a</Badge>
              <Badge>b</Badge>
            </Grid>
            <Grid gap={2} min="8em">
              {["a", "b", "c", "d"].map((x) => (
                <Badge key={x}>{x}</Badge>
              ))}
            </Grid>
          </Stack>
        </Cell>
      </Group>

      <Group title="Root and boundary">
        <Cell component="UiRoot" state='scheme="system" (this page) · "light" pins light'>
          <p className={css.note}>
            This whole page is one <code className={css.code}>UiRoot</code>, the outermost root (never nested: a
            nested root starts light again). The three schemes are drawn with the tokens above.
          </p>
        </Cell>
        <Cell component="Legacy" state="old content inside a .ui root">
          <Stack gap={3}>
            <Button>System button</Button>
            <Legacy>
              <button className="btn" type="button">
                .btn inside Legacy: no system rule reaches it
              </button>
            </Legacy>
          </Stack>
        </Cell>
      </Group>
    </Part>
  );
}

function SampleTable({ capped = false, keys = false, rows = 3 }: { capped?: boolean; keys?: boolean; rows?: number }) {
  return (
    <Table capped={capped} keys={keys} aria-label={keys ? "Keys table" : "Documents"}>
      <thead>
        <tr>
          <th scope="col">Title</th>
          <th scope="col">Project</th>
          <th scope="col" className="num">
            Words
          </th>
          <th scope="col" className="at-end">
            <span className="sr-only">Action</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }, (_, i) => (
          <tr key={i}>
            <td className="strong">Document {i + 1}</td>
            <td className="nowrap">changple</td>
            <td className="num">{(i + 1) * 312}</td>
            <td className="at-end">
              <Button variant="quiet">Open</Button>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

// -- frame -----------------------------------------------------------------------------------------

const FORMAT = { now: Date.parse("2026-11-20T12:00:00Z"), timeZone: "UTC" };
const KEY_ROWS: KeyRow[] = [
  {
    id: "k1",
    name: "Laptop",
    prefix: "vk_91c4e7",
    access: "full",
    status: "active",
    created: "2026-10-02",
    lastUsed: "2026-11-20T10:12:00Z",
  },
  {
    id: "k2",
    name: null,
    prefix: "vk_0be221",
    access: "capture",
    status: "idle",
    created: "2026-08-14",
    lastUsed: null,
  },
  {
    id: "k3",
    name: "Workspace sync",
    prefix: "vk_7d10aa",
    access: "workspace",
    status: "revoked",
    created: "2026-06-30",
    lastUsed: "2026-07-01T08:00:00Z",
  },
];
const mint = async () => ({ ok: true as const, key: "vk_demo_not_a_real_key" });
const revoke = async () => ({ ok: true as const });
const SERIES = Array.from({ length: 30 }, (_, i) => Math.round(6 + 5 * Math.sin(i / 3) + (i % 7)));

/**
 * The real `Dialog` (or a component that opens one), drawn open in place: it opens itself with `showModal()`; once
 * it has, this reopens it with `show()`, so the system's `.dlg:not(:modal)` draws it in the page flow instead of
 * over the page.
 */
function InPlace({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const scroll = useRef(0);
  useLayoutEffect(() => {
    scroll.current = window.scrollY;
  }, []);
  useEffect(() => {
    const dialog = box.current?.querySelector("dialog");
    if (dialog?.open) {
      dialog.close();
      dialog.show();
    }
    if (document.activeElement instanceof HTMLElement && box.current?.contains(document.activeElement))
      document.activeElement.blur();
    window.scrollTo(0, scroll.current);
  }, []);
  return <div ref={box}>{children}</div>;
}

function InPlaceDialog(props: Omit<DialogProps, "onClose">) {
  return (
    <InPlace>
      <Dialog {...props} onClose={() => {}} />
    </InPlace>
  );
}

/** The delete confirm (P88-ms), its name typed so far. */
function InPlaceDelete({ typed }: { typed: string }) {
  return (
    <InPlace>
      <DeleteDialog
        name="Sample org"
        text="Its 2 projects and everything in them go for good, for all 3 members."
        confirm="Delete org"
        remove={async () => ({ ok: true })}
        onDeleted={() => {}}
        onClose={() => {}}
        refusal={() => ""}
        typed={typed}
      />
    </InPlace>
  );
}

function FrameParts() {
  return (
    <Part
      id="frame"
      title="@/sikstack/frame"
      note="The frame's shared components. Keys' form, its show-once key and its revoke confirm open on a click (component state, not props); the Dialog they use is drawn open below."
    >
      <Group title="Keys">
        <Cell component="Keys" state='scope="org" · rows (active, idle, revoked)' wide>
          <Keys scope="org" subject="Acme Studio" rows={KEY_ROWS} mint={mint} revoke={revoke} format={FORMAT} />
        </Cell>
        <Cell component="Keys" state='scope="project" workspace · rows={[]}' wide>
          <Keys scope="project" workspace subject="changple" rows={[]} mint={mint} revoke={revoke} format={FORMAT} />
        </Cell>
        <Cell component="Keys" state="loading" wide>
          <Keys scope="org" subject="Acme Studio" rows={[]} mint={mint} revoke={revoke} loading />
        </Cell>
      </Group>
      <Group title="Trend">
        <Cell component="Trend" state="series (filled)">
          <Trend series={SERIES} lastDay="2026-11-20" format={FORMAT} />
        </Cell>
        <Cell component="Trend" state="series all zero (empty)">
          <Trend series={Array(30).fill(0)} lastDay="2026-11-20" format={FORMAT} />
        </Cell>
        <Cell component="Trend" state="loading">
          <Trend series={[]} lastDay="2026-11-20" loading format={FORMAT} />
        </Cell>
      </Group>
      <Group title="Copy">
        <Cell component="Copy" state="field">
          <Copy text="https://sikstack.com/@acme/changple" label="Copy public URL" />
        </Cell>
        <Cell component="Copy" state="field mono primary (the key)">
          <Copy text="vk_demo_not_a_real_key" label="Copy key" mono primary />
        </Cell>
        <Cell component="Copy" state='block what="Install command"'>
          <Copy block what="Install command" text={"claude plugin marketplace add sikstack\nclaude plugin install sikstack"} />
        </Cell>
      </Group>
      <Group title="Dialog">
        <Cell component="Dialog DialogActions" state="open (drawn in place)">
          <InPlaceDialog label="Revoke Laptop?">
            <h2>Revoke Laptop?</h2>
            <p>Anything using this key stops working at once.</p>
            <DialogActions>
              <Button>Cancel</Button>
              <Button variant="danger">Yes, revoke</Button>
            </DialogActions>
          </InPlaceDialog>
        </Cell>
        <Cell component="Dialog DialogActions" state="open locked (a send in flight)">
          <InPlaceDialog label="Revoking Laptop" locked>
            <h2>Revoke Laptop?</h2>
            <p>Escape does nothing while the send is in flight.</p>
            <DialogActions>
              <Button disabled>Cancel</Button>
              <Button variant="danger" busy busyLabel="Revoking…">
                Yes, revoke
              </Button>
            </DialogActions>
          </InPlaceDialog>
        </Cell>
      </Group>
      <Group title="DeleteDialog">
        <Cell component="DeleteDialog" state='typed="" (Delete off)'>
          <InPlaceDelete typed="" />
        </Cell>
        <Cell component="DeleteDialog" state='typed="sample org" (wrong: the field shows its error)'>
          <InPlaceDelete typed="sample org" />
        </Cell>
        <Cell component="DeleteDialog" state='typed="Sample org" (Delete ready)'>
          <InPlaceDelete typed="Sample org" />
        </Cell>
      </Group>
      <Group title="Usage">
        <Cell component="Usage" state="figures" wide>
          <Usage figures={{ docs30: 42, searches30: 1284, deleted30: 3, docs: 518 }} />
        </Cell>
        <Cell component="Usage" state="figures all zero" wide>
          <Usage figures={{ docs30: 0, searches30: 0, deleted30: 0, docs: 0 }} />
        </Cell>
        <Cell component="Usage" state="loading" wide>
          <Usage loading />
        </Cell>
        <Cell component="Usage" state='loading busyLabel="Loading…" (org home)' wide>
          <Usage loading busyLabel="Loading…" />
        </Cell>
      </Group>
    </Part>
  );
}

// -- states ----------------------------------------------------------------------------------------

function NamedNotFound() {
  return <StateBlock state={notFoundState({ orgName: useShellOrgName() })} />;
}

function StatesParts() {
  return (
    <Part id="states" title="@/sikstack/states" note="The app's whole-page states, drawn from their own models.">
      <Group title="StateBlock">
        <Cell component="StateBlock" state='errorState({ orgName: "Acme Studio" }) · onRetry'>
          <StateBlock state={errorState({ orgName: "Acme Studio" })} onRetry={() => {}} />
        </Cell>
        <Cell component="StateBlock" state='errorState({ orgName, digest: "3818243951" }) · onRetry'>
          <StateBlock state={errorState({ orgName: "Acme Studio", digest: "3818243951" })} onRetry={() => {}} />
        </Cell>
        <Cell component="StateBlock" state="errorState({ orgName: null }) (the root error) · onRetry">
          <StateBlock state={errorState({ orgName: null })} onRetry={() => {}} />
        </Cell>
        <Cell component="StateBlock" state='notFoundState({ orgName: "Acme Studio" })'>
          <StateBlock state={notFoundState({ orgName: "Acme Studio" })} />
        </Cell>
        <Cell component="StateBlock" state="notFoundState({ orgName: null }) (signed out)">
          <StateBlock state={notFoundState({ orgName: null })} />
        </Cell>
        <Cell component="StateBlock" state="narrow">
          <StateBlock state={notFoundState({ orgName: "Acme Studio" })} narrow />
        </Cell>
      </Group>
    </Part>
  );
}

// -- shell -----------------------------------------------------------------------------------------

const ORG = RECORDING.shell.org;
const ORG_ROW: ShellOrg = { ...ORG, address: null, projects: 1 };
const SECOND_ORG: ShellOrg = { id: "org-2", name: "Side Projects", address: "sikstack.com/@side", projects: 4 };
const projectsOf = (n: number): ShellProject[] =>
  Array.from({ length: n }, (_, i) => ({
    id: i === 0 ? PROJECT : `${PROJECT}-${i}`,
    name: i === 0 ? RECORDING.shell.project.name : `project-${i + 1}`,
    visibility: i % 2 ? "public" : "private",
    created_at: RECORDING.shell.project.created_at,
  }));

function ShellBox({ children }: { children: ReactNode }) {
  return (
    <div className={`${css.frame} ${css.tall}`}>
      <div className="app">
        <div className="app-frame">{children}</div>
      </div>
    </div>
  );
}

function ToastSample() {
  // The toast leaves after 4 s (TOAST_MS); republished every 3 s so it stays on the board.
  useEffect(() => {
    publishToast("Project changple created.");
    const t = setInterval(() => publishToast("Project changple created."), 3000);
    return () => clearInterval(t);
  }, []);
  return (
    <main className="app-main">
      <p>The page; the toast sits at the main column&apos;s foot.</p>
      <ToastRegion />
    </main>
  );
}

function ShellParts() {
  return (
    <Part
      id="shell"
      title="@/sikstack/shell"
      note="The Shell follows the address (here, /system/, so the org rail); its menus open on a click. Each Shell sits in a box of its own."
    >
      <Group title="Shell">
        <Cell component="Shell" state="orgs=[one] (plain name) · projects=[] (no project switcher) · due=0" wide>
          <ShellBox>
            <Shell org={ORG} orgs={[ORG_ROW]} projects={[]} email={RECORDING.shell.email} due={0} orgRoute="/org" />
          </ShellBox>
        </Cell>
        <Cell component="Shell" state="orgs=[two] (a menu) · projects=[3] · due=5" wide>
          <ShellBox>
            <Shell
              org={ORG}
              orgs={[ORG_ROW, SECOND_ORG]}
              projects={projectsOf(3)}
              email={RECORDING.shell.email}
              due={5}
              orgRoute="/org"
            />
          </ShellBox>
        </Cell>
        <Cell component="Shell" state="projects=[9] (the filter, in the open menu) · due=120 (99+)" wide>
          <ShellBox>
            <Shell
              org={ORG}
              orgs={[ORG_ROW]}
              projects={projectsOf(9)}
              email={RECORDING.shell.email}
              due={120}
              orgRoute="/org"
            />
          </ShellBox>
        </Cell>
      </Group>
      <Group title="Toast, the org's name, an old page">
        <Cell component="ToastRegion" state="holding one toast (empty, it draws nothing)">
          <div className={css.frame} style={{ height: 160 }}>
            <ToastSample />
          </div>
        </Cell>
        <Cell component="ShellOrgNameProvider useShellOrgName" state='name="Acme Studio" · outside it "—"'>
          <Stack gap={3}>
            <ShellOrgNameProvider name="Acme Studio">
              <NamedNotFound />
            </ShellOrgNameProvider>
            <NamedNotFound />
          </Stack>
        </Cell>
        <Cell component="LegacyPage" state="fullWidth={false} | fullWidth">
          <Stack gap={3}>
            <div className={css.frame} style={{ height: 120 }}>
              <LegacyPage>
                <h1 className="text-xl font-semibold">An old page</h1>
                <p className="text-sm">Its own styling, inside the Shell.</p>
              </LegacyPage>
            </div>
            <div className={css.frame} style={{ height: 120 }}>
              <LegacyPage fullWidth>
                <p className="text-sm">The chrome-less document view (?view=full).</p>
              </LegacyPage>
            </div>
          </Stack>
        </Cell>
      </Group>
    </Part>
  );
}

// -- exports that are not components ---------------------------------------------------------------

const NOT_DRAWN: { name: string; from: string; why: string }[] = [
  { name: "buttonClass", from: "@/sikstack/ui", why: "a function: the class Button and ButtonLink draw with" },
  { name: "LEGACY_BOUNDARY", from: "@/sikstack/ui", why: "a constant: the attribute Legacy sets" },
  { name: "meterPercent", from: "@/sikstack/ui", why: "a function: the share Meter draws" },
  { name: "errorState", from: "@/sikstack/states", why: "a function: the model StateBlock draws (above)" },
  { name: "notFoundState", from: "@/sikstack/states", why: "a function: the model StateBlock draws (above)" },
  { name: "boundaryRetry", from: "@/sikstack/states", why: "a function: what Try again calls in an error boundary" },
  { name: "publishToast", from: "@/sikstack/shell", why: "a function: shows the toast ToastRegion draws (above)" },
  { name: "clearToast", from: "@/sikstack/shell", why: "a function: takes the toast down" },
  { name: "TOAST_MS", from: "@/sikstack/shell", why: "a constant: how long a toast stays (4 s)" },
  { name: "typedNameMatches", from: "@/sikstack/frame", why: "a function: whether DeleteDialog's Delete is ready (above)" },
  { name: "typedNameWrong", from: "@/sikstack/frame", why: "a function: when DeleteDialog's field says the name is wrong (above)" },
];

function NotDrawn() {
  return (
    <Part id="exports" title="Exports that are not components" note="What each is, and what draws it.">
      <ul className={css.rows} style={{ margin: 0, paddingLeft: 16 }}>
        {NOT_DRAWN.map((x) => (
          <li key={x.name} data-export={x.name} className={css.note}>
            <code className={css.code}>{x.name}</code> ({x.from}): {x.why}
          </li>
        ))}
      </ul>
    </Part>
  );
}

// -- the page --------------------------------------------------------------------------------------

const TOC = [
  ["tokens", "Tokens"],
  ["ui", "ui"],
  ["frame", "frame"],
  ["states", "states"],
  ["shell", "shell"],
  ["exports", "Other exports"],
] as const;

export function SystemBoard({ sheet, source }: { sheet: TokenSheet; source: string }) {
  return (
    <UiRoot data-design={DESIGN_MARK}>
      <div className={css.board}>
        <header className={css.head}>
          <h1 className={css.partTitle} style={{ border: 0, fontSize: 28, lineHeight: "32px" }}>
            sikstack system
          </h1>
          <p className={css.note}>
            The product&apos;s tokens and shared components, drawn by the real code: the reference the drafter and
            the operator read. Design build only.
          </p>
          <nav aria-label="System sections">
            <ul className={css.toc}>
              {TOC.map(([id, label]) => (
                <li key={id}>
                  <a href={`#${id}`}>{label}</a>
                </li>
              ))}
            </ul>
          </nav>
        </header>
        <Tokens sheet={sheet} source={source} />
        <UiParts />
        <FrameParts />
        <StatesParts />
        <ShellParts />
        <NotDrawn />
      </div>
    </UiRoot>
  );
}
