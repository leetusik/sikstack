// The frame's shared components (job 01, round 03, frame.md F10): Keys, Trend, Copy (field and block
// forms), Dialog and the two-group usage read-out. They emit the signed markup and classes of
// src/sikstack/styles/ and use the primitives of `@/sikstack/ui`; no styling of their own. Their words are
// `@/content/sikstack-frame`.
export { Keys, type KeysProps } from "./keys";
export {
  type KeyAccess,
  type KeyRow,
  type KeyStatus,
  type MintInput,
  type MintResult,
  type RevokeResult,
} from "./keys-state";
export { Trend, type TrendProps } from "./trend";
export {
  Copy,
  type CopyBlockProps,
  type CopyFieldProps,
  type CopyProps,
} from "./copy";
export { Dialog, DialogActions, type DialogProps } from "./dialog";
export {
  DeleteDialog,
  typedNameMatches,
  typedNameWrong,
  type DeleteDialogProps,
  type DeletePhase,
  type DeleteRefusal,
  type DeleteResult,
} from "./delete-dialog";
export { Usage, type UsageFigures, type UsageProps } from "./usage";
