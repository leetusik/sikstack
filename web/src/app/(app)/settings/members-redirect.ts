/**
 * `next.config.ts`'s rule for Members' old address (P88-ms.S3's signed design, decided as drawn): Members is a part
 * of Org settings, so `/members` answers a permanent redirect (308) to `/settings`, its query kept. A config
 * redirect answers before the proxy and before any page, so old links and bookmarks land there signed in or not
 * (signed out, `/settings` sends the visitor to sign-in as every app page does).
 */
export const MEMBERS_REDIRECT = {
  source: "/members",
  destination: "/settings",
  permanent: true,
} as const;
