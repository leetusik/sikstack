import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { SystemBoard } from "../../lib/system-board";
import { parseTokens } from "../../lib/tokens";

// The system page: the product's tokens, read from `src/sikstack/styles/tokens.css` as the build runs, and
// every shared component of `@/sikstack/{ui,frame,states,shell}` in its states, drawn by the real components.
export const metadata = { title: "System" };

const TOKENS = "src/sikstack/styles/tokens.css";

function tokensFile(): string {
  // `next build design` runs from web/; a run from design/ finds it one level up.
  for (const base of [process.cwd(), path.join(process.cwd(), "..")]) {
    const file = path.join(base, TOKENS);
    if (existsSync(file)) return file;
  }
  throw new Error(`design: no ${TOKENS} from ${process.cwd()}`);
}

export default function SystemPage() {
  const sheet = parseTokens(readFileSync(tokensFile(), "utf8"));
  return <SystemBoard sheet={sheet} source={TOKENS} />;
}
