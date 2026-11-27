import { MembersMovedRoute } from "../../lib/members-moved";

// Members (P78-s2.S2's page) is a part of Org settings since P88-ms.S3's design: production's `/members` becomes a
// permanent redirect to `/settings` (`next.config.ts` `redirects`, or the route's `redirect()`), so old links and
// bookmarks land there. A static build has no redirect: this page moves the browser on, and is not in the manifest.
export const metadata = { title: "Members" };

export default function MembersPage() {
  return <MembersMovedRoute />;
}
