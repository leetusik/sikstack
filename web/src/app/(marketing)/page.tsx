import { unstable_rethrow } from "next/navigation";
import { connection } from "next/server";

import { Landing } from "@/sikstack/landing";
import { optionalIdentity } from "@/lib/auth-guards";
import { feedbackControl } from "@/lib/send-feedback/config";

// The public landing at `/` (job 06, round 01-landing, signed), with sikstack's own feedback control in
// its footer (job 08, round 01-landing-diagram-feedback, `## Build` 3c-3d) where the server holds the
// control's key. `connection()` makes the page wait for a request, so the key is read from the running
// server's environment on every request, never frozen into a page prerendered at build time.
//
// P78, F8: a visitor with a live session is led to the dashboard (`signedIn`). The session is checked as every
// public page checks it (`optionalIdentity`); an API that does not answer reads as signed out, so the landing
// never fails with the API.
async function signedIn(): Promise<boolean> {
  try {
    return (await optionalIdentity()) !== null;
  } catch (error) {
    unstable_rethrow(error);
    return false;
  }
}

export default async function LandingPage() {
  await connection();
  const feedback = feedbackControl();
  return (
    <Landing
      signedIn={await signedIn()}
      sendFeedback={feedback.configured ? { limit: feedback.limit } : undefined}
    />
  );
}
