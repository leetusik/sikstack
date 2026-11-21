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

const config: NextConfig = {
  output: "export",
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
      "design-recording": `./${path.relative(here, recording).split(path.sep).join("/")}`,
    },
  },
};

export default config;
