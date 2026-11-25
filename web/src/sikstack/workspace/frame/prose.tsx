import type { Nodes, Root } from "mdast";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { splitIds } from "./ids";

/**
 * Stored prose (frame.md F46, F80): a line the workspace wrote (a notebook's line, the gate's note and steps, the
 * review's note, a slice's outcome and its one sentence, a stop's words, an
 * agenda's note, outcome and reason, a doc version's summary, a phase's objective), drawn as the Markdown it
 * is: its bold, emphasis and code as the `.md` text draws them (the verdict's sentences), never its marks as
 * characters. A link keeps only its text: the workspace's links name its own files (`topics/<slug>.md`), which
 * have no address here, and a line inside a row's link must hold no second link. Each workspace id stays whole
 * (`span.ws-nobr`, F80), as `WsText` keeps it. Titles are plain text (`WsText` or the text itself), never this.
 *
 * - inline (the default): one line inside its row; any block (a paragraph, a list) is unwrapped to its text.
 * - `block`: Now, lines kept as written: a line break stays a line break, a list stays a list.
 *
 * Server-rendered only: it is not in the frame's barrel (`./index.ts`), which client components import, so the
 * Markdown renderer stays out of the client bundle. A client part takes its text already drawn, as a node.
 */
const INLINE = ["strong", "em", "del", "code", "br", "span"];
const BLOCK = [...INLINE, "p", "ul", "ol", "li"];

/** Splits the text nodes outside code into the text and the workspace ids in it (F80). */
function remarkWsIds() {
  const walk = (node: Nodes) => {
    if (!("children" in node)) return;
    const out: Nodes[] = [];
    for (const child of node.children as Nodes[]) {
      if (child.type !== "text") {
        walk(child);
        out.push(child);
        continue;
      }
      for (const part of splitIds(child.value)) {
        out.push(
          part.id
            ? ({
                type: "wsNobr",
                children: [{ type: "text", value: part.text }],
                data: {
                  hName: "span",
                  hProperties: { className: ["ws-nobr"] },
                },
              } as unknown as Nodes)
            : { type: "text", value: part.text },
        );
      }
    }
    (node as { children: Nodes[] }).children = out;
  };
  return (tree: Root) => walk(tree);
}

/** Soft breaks become line breaks: Now's lines are lines, as the engine writes them. */
function keepLines(text: string): string {
  return text.replace(/[ \t]*\n(?=[^\n])/g, "  \n");
}

export function WsProse({
  text,
  block = false,
}: {
  text: string;
  block?: boolean;
}) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm, remarkWsIds]}
      allowedElements={block ? BLOCK : INLINE}
      unwrapDisallowed
    >
      {block ? keepLines(text) : text}
    </Markdown>
  );
}

/**
 * A long value's stored prose (a fact on its own line, F80: an agenda's note, outcome and reason): its lines and lists kept as written, in one column (`.ws-prose-block`).
 */
export function WsProseBlock({ text }: { text: string }) {
  return (
    <div className="ws-prose-block">
      <WsProse text={text} block />
    </div>
  );
}
