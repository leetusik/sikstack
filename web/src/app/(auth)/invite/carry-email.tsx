"use client";

import { useEffect } from "react";

import { useAuthEmail } from "../auth-email";

/**
 * Signed out, the invite page hands its invited address to the `(auth)` layout's memory (`useAuthEmail`), so the
 * sign-in pair's Sign in and Create account open with it in Email (the design's OQ5), and it stays out of the URL as
 * every carried email does. Renders nothing.
 */
export function CarryInviteEmail({ email }: { email: string }) {
  const { setEmail } = useAuthEmail();
  useEffect(() => {
    if (email) setEmail(email);
  }, [email, setEmail]);
  return null;
}
