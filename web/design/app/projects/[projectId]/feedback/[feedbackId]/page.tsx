import type { Metadata } from "next";

import { itemHeading } from "@/content/feedback-frame";

import { FEEDBACK } from "../../../../../lib/answers";
import { FeedbackRoute } from "../../../../../lib/feedback-screens";
import { PROJECT, RECORDING } from "../../../../../lib/recording";

// One piece of feedback, at production's address (`src/app/(app)/projects/[projectId]/feedback/[feedbackId]/page.tsx`):
// one page for each piece the recording holds (`record.mjs --feedback`).
export const metadata: Metadata = { title: itemHeading(RECORDING.shell.project.name) };
export const dynamicParams = false;

export function generateStaticParams() {
  return Object.keys(FEEDBACK).map((feedbackId) => ({ projectId: PROJECT, feedbackId }));
}

export default async function FeedbackItemPage({
  params,
}: {
  params: Promise<{ feedbackId: string }>;
}) {
  const { feedbackId } = await params;
  return <FeedbackRoute id={feedbackId} />;
}
