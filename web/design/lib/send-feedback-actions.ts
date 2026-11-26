// The design build's `@/lib/send-feedback/actions` (`next.config.ts` aliases it here): the same exports and the same
// answers (`SendFeedbackResult`), with the same early checks (`check.ts`), answered in the browser instead of by the
// server, which a static build cannot have. A valid message is answered `sent` (made: no capture key, nothing is
// posted). Production's limit is the server's (`config.ts` FEEDBACK_DEFAULTS.maxChars); the design's page passes it.
import {
  checkMessage,
  checkReplyEmail,
  type SendFeedbackResult,
} from "@/lib/send-feedback/check";

/** The landing's page passes production's default limit (`config.ts:15`); the check reads it from here. */
export const DESIGN_FEEDBACK_LIMIT = 2000;

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

export async function sendLandingFeedback(input: {
  message: string;
  email?: string;
  website?: string;
}): Promise<SendFeedbackResult> {
  const message = checkMessage(input.message, DESIGN_FEEDBACK_LIMIT);
  if (message) return { status: "invalid", field: "message", reason: message };
  const email = input.email?.trim();
  if (email) {
    const refused = checkReplyEmail(email);
    if (refused) return { status: "invalid", field: "email", reason: refused };
  }
  await settle();
  return { status: "sent" };
}

export async function sendOrgHomeFeedback(input: { message: string }): Promise<SendFeedbackResult> {
  const message = checkMessage(input.message, DESIGN_FEEDBACK_LIMIT);
  if (message) return { status: "invalid", field: "message", reason: message };
  await settle();
  return { status: "sent" };
}
