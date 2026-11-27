"use client";

import Link from "next/link";
import { useEffect } from "react";

/** `/members` in the design build: production's redirect to Org settings, done in the browser (a static build). */
export function MembersMovedRoute() {
  useEffect(() => {
    window.location.replace(`/settings/${window.location.search}`);
  }, []);
  return (
    <p>
      <Link href="/settings/">Org settings</Link>
    </p>
  );
}
