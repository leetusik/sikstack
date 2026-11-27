import { FEEDBACK } from "@/content/feedback-frame";

import { FeedbackListRoute } from "../../lib/feedback-list-screens";

// The Feedback list (P91-v3.S3's design), at production's address (`src/app/(app)/feedback/page.tsx`), the org's list;
// a project's list (`/projects/[projectId]/feedback`) is the same component. Made data (`lib/feedback-list-data.ts`).
export const metadata = { title: FEEDBACK };

export default function FeedbackListPage() {
  return <FeedbackListRoute />;
}
