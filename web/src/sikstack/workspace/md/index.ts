// The Workspace's Markdown body (design job 02, frame.md F46): `Md`, a real renderer whose output carries the
// `.md` classes of src/sikstack/styles/workspace/md.css. The pure model (no React, no I/O) is tested on its own.
//
// - `Md`: the body, its three heading steps, its scroll boxes for code and tables, the way to a section.
// - `mdSections`, `mdHasOutline`, `prepareMd`: the steps, the section ids and the outline's rule.
// - `mdImageSrc`: an image's address when it stays on this site; one from another host draws its alt text (D310).
export { Md, type MdProps } from "./md";
export {
  MD_OUTLINE_MIN,
  mdHasOutline,
  mdImageSrc,
  mdSections,
  prepareMd,
  remarkWorkspaceMd,
  type MdOptions,
  type MdSection,
} from "./md-model";
export { MD_WORDS } from "./words";
