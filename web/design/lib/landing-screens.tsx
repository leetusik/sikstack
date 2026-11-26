"use client";

import { Landing } from "../next/landing/landing";
import { DESIGN_MARK } from "./mark";
import { LANDING_STATES, type LandingState } from "./page-states";
import { DESIGN_FEEDBACK_LIMIT } from "./send-feedback-actions";
import { StatePage } from "./states";

/**
 * The landing (P83-8k.S1's design, the next `Landing`: production's, its Connect section offering only the
 * plugin), in the states its route draws (`src/app/(marketing)/page.tsx`): signed out with the footer's feedback control (sikstack.com holds its key),
 * signed in, and signed out where the server holds no key. The landing reads no API: its words are its data.
 */
export function LandingRoute() {
  return (
    <StatePage states={LANDING_STATES}>
      {(state: LandingState) => (
        // `display: contents`: the mark for the production-exclusion check, with no box of its own.
        <div data-design={DESIGN_MARK} style={{ display: "contents" }}>
          <Landing
            key={state}
            signedIn={state === "signed-in"}
            sendFeedback={state === "no-feedback-key" ? undefined : { limit: DESIGN_FEEDBACK_LIMIT }}
          />
        </div>
      )}
    </StatePage>
  );
}
