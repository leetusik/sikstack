import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { NextConfig } from "next";

/**
 * The design build: a second Next project over web's own `src/` and `node_modules`, exported as static
 * files (`out/`) that any plain file server can serve. Production's component files are imported
 * unchanged; one alias swaps the Workspace's write actions (server actions, which a static build cannot
 * have) for the browser store's (`lib/actions.ts`), and one names the recording the pages read:
 * `data/sample/recording.json`, or `$DESIGN_RECORDING` (a path under `data/local/`, gitignored).
 *
 * Build and serve with `pnpm --dir web design:build` and `design:serve`; never `next dev` here beside
 * web's own dev server.
 */
const here = __dirname;
const web = path.join(here, "..");
const recording = path.resolve(
  here,
  process.env.DESIGN_RECORDING || "data/sample/recording.json",
);

/**
 * The build's stamp (`lib/mark.ts`, `DESIGN_STAMP`): a hash of what the browser store holds, so a browser that kept
 * a snapshot of another recording or another build's data drops it on load. It covers the recording, the state
 * answers and the files that shape a snapshot.
 */
const states = path.join(here, "data", "sample", "states");
const stamped = [
  recording,
  ...readdirSync(states).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(states, f)),
  ...["answers.ts", "apply.ts", "ids.ts", "store.ts"].map((f) => path.join(here, "lib", f)),
];
const stamp = createHash("sha256");
for (const file of stamped) stamp.update(path.relative(here, file)).update("\0").update(readFileSync(file)).update("\0");

const config: NextConfig = {
  output: "export",
  env: { DESIGN_STAMP: stamp.digest("hex").slice(0, 16) },
  trailingSlash: true,
  // `out/` is the export; the build's own files stay in `design/.next/` (both gitignored).
  distDir: "out",
  agentRules: false,
  images: { unoptimized: true },
  turbopack: {
    root: web,
    // Relative targets resolve from this folder.
    resolveAlias: {
      "@/lib/workspace/actions": "./lib/actions.ts",
      // P78-s2.S2's org surfaces: the Shell's next version (the org menu for every account with New org, the org
      // rail's Members), drawn in place of production's wherever it is imported: by path, and as the shell
      // index's "./shell" (the key catches every "./shell" import; production has only that one). Its rules come
      // with it: "@/sikstack/shell/model" (the design's `away.ts` reads the rail from it).
      "@/sikstack/shell/shell": "./next/shell/shell.tsx",
      "./shell": "./next/shell/shell.tsx",
      "@/sikstack/shell/model": "./next/shell/model.ts",
      "design-recording": `./${path.relative(here, recording).split(path.sep).join("/")}`,
    },
  },
};

export default config;
