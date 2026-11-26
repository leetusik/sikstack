import { cloneElement, isValidElement, type ReactElement } from "react";

import { listProjects } from "@/lib/knowledge/app";
import type { KbDocument } from "@/lib/knowledge/types";

import { DocumentReader, type DocumentReaderProps } from "./document-reader";
import { phaseRows, type DocPhaseRow } from "./model";

/**
 * The phases a member's document read names, as the reader's rows (`phaseRows`). The document keys off its
 * project's name and the Workspace's addresses off the project's id, so a read that names phases is followed by
 * one project list, to find the id. No phases, no read; a failed read, no rows (the page never fails over it).
 */
export async function documentPhaseRows(
  token: string | undefined,
  doc: Pick<KbDocument, "project" | "phases">,
): Promise<DocPhaseRow[]> {
  if (!token || !doc.phases?.length) return [];
  try {
    const projects = await listProjects(token);
    const project = projects.find((p) => p.name === doc.project);
    return phaseRows(doc.phases, project?.id ?? null);
  } catch {
    return [];
  }
}

/**
 * The page's reader with its way back to the phases: the `DocumentReader` element `renderDocument` returns for
 * a Markdown or native document, given `phases`. The html original, and no rows, come back as they were.
 */
export function withDocumentPhases(
  el: ReactElement,
  rows: readonly DocPhaseRow[],
): ReactElement {
  if (rows.length === 0 || !isValidElement(el) || el.type !== DocumentReader)
    return el;
  return cloneElement(el as ReactElement<DocumentReaderProps>, {
    phases: rows,
  });
}

/**
 * The page's reader with a member's sharing switch (P75): the document's `share` (a member's read only) and its
 * id as the switch's target. A visitor's or link reader's read carries none, and the html original comes back
 * as it was.
 */
export function withDocumentShare(
  el: ReactElement,
  doc: Pick<KbDocument, "id" | "share">,
): ReactElement {
  if (!doc.share || !isValidElement(el) || el.type !== DocumentReader) return el;
  return cloneElement(el as ReactElement<DocumentReaderProps>, {
    share: { target: { kind: "doc", docId: doc.id }, share: doc.share },
  });
}
