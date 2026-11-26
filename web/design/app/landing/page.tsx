import { LANDING } from "@/content/marketing";
import { LandingRoute } from "../../lib/landing-screens";

// The landing (P83-8k.S1's design), production's `/` (`src/app/(marketing)/page.tsx`): the build's own `/` is its
// front page, so the landing is drawn here. The title is absolute, as production's `(marketing)` layout sets it.
export const metadata = { title: { absolute: LANDING.meta.title } };

export default function LandingDesignPage() {
  return <LandingRoute />;
}
