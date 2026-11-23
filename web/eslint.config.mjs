import next from "eslint-config-next";

/**
 * Flat config for Next.js 16. `eslint-config-next` (main export) is itself a
 * ready-to-spread flat-config array that already bundles next/core-web-vitals,
 * the TypeScript block, and the global ignores (.next, out, build,
 * next-env.d.ts) — so no FlatCompat shim is needed.
 */
const eslintConfig = [
  ...next,
  // The design build's own output (design/next.config.ts): generated files, like web's `.next`.
  { ignores: ["design/.next/**", "design/out/**", "design/next-env.d.ts"] },
];

export default eslintConfig;
