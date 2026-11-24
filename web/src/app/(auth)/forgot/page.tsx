import type { Metadata } from "next";

import { FORGOT_COPY } from "@/content/auth";
import { redirectIfAuthenticated } from "@/lib/auth-guards";

import { ForgotForm } from "./forgot-form";

// `/forgot` (P78, F10): ask for a reset link, in the sign-in frame. A signed-in visitor is sent on to org home, as
// `/login` does (the account page changes a known password).
export const metadata: Metadata = {
  title: FORGOT_COPY.title,
};

export default async function ForgotPage() {
  await redirectIfAuthenticated();
  return <ForgotForm />;
}
