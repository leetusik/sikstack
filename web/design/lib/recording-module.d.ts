// The recording the design build reads, chosen at build time: `next.config.ts` aliases this
// specifier to `data/sample/recording.json` or to `$DESIGN_RECORDING` (a file under `data/local/`).
declare module "design-recording" {
  const recording: unknown;
  export default recording;
}
