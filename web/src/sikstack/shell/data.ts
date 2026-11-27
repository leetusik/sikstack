import "server-only";

import { headers } from "next/headers";

import { SITE } from "@/content";
import { getJson } from "@/lib/knowledge/client";
import type { KbIdentity, KbProject, KbTenant } from "@/lib/knowledge/types";
import { getSession } from "@/lib/session";

import {
  newestFirst,
  nonceFromCsp,
  type ShellOrg,
  type ShellProject,
} from "./model";

/** `GET /app/projects` → `{projects}` (the envelope `lib/knowledge/app.ts` keeps private). */
interface RawProjects {
  projects?: KbProject[];
}

/**
 * The projects of one org, read in that org (`X-Sikstack-Org`) or, with `org` undefined, in the active
 * one. A fault is `null`: the Shell never fails over its switchers.
 */
async function projectsIn(
  token: string,
  org: string | undefined,
): Promise<KbProject[] | null> {
  try {
    const raw = await getJson<RawProjects>("/app/projects", {
      token,
      ...(org === undefined ? {} : { org }),
    });
    return raw.projects ?? [];
  } catch {
    return null;
  }
}

function host(): string {
  try {
    return new URL(SITE.url).host;
  } catch {
    return "sikstack.com";
  }
}

/** The org switcher's address line: `sikstack.com/@slug`, or `null` with no slug. */
function addressOf(tenant: KbTenant, siteHost: string): string | null {
  return tenant.slug ? `${siteHost}/@${tenant.slug}` : null;
}

export interface ShellData {
  orgs: ShellOrg[];
  projects: ShellProject[];
}

/**
 * What the Shell shows of the account's orgs and the active org's projects. One read for a user in one
 * org (the active org's projects); one more per other org for a user in several, for each row's
 * project count (F9: name, public URL, project count), and each org's first owner (`GET /auth/me`'s `owner_email`,
 * the org menu's line for a shared name, P88-ms).
 */
export async function loadShellData(identity: KbIdentity): Promise<ShellData> {
  const token = await getSession();
  const active = identity.tenant;
  const siteHost = host();
  const tenants =
    identity.tenants.length > 0 ? identity.tenants : active ? [active] : [];
  if (!token) {
    return {
      orgs: tenants.map((t) => ({
        id: t.id,
        name: t.name,
        address: addressOf(t, siteHost),
        projects: null,
        owner: t.owner_email ?? null,
      })),
      projects: [],
    };
  }
  const multi = tenants.length > 1;
  const reads = await Promise.all(
    tenants.map((t) =>
      t.id === active?.id
        ? projectsIn(token, undefined)
        : multi
          ? projectsIn(token, t.id)
          : Promise.resolve(null),
    ),
  );
  const activeIndex = tenants.findIndex((t) => t.id === active?.id);
  const activeProjects =
    activeIndex >= 0
      ? (reads[activeIndex] ?? [])
      : ((await projectsIn(token, undefined)) ?? []);
  return {
    orgs: tenants.map((t, i) => ({
      id: t.id,
      name: t.name,
      address: addressOf(t, siteHost),
      projects: reads[i] ? reads[i].length : null,
      owner: t.owner_email ?? null,
    })),
    projects: newestFirst(
      activeProjects.map((p): ShellProject => ({
        id: p.id,
        name: p.name,
        visibility: p.visibility === "public" ? "public" : "private",
        created_at: p.created_at,
      })),
    ),
  };
}

/** The request's CSP nonce (the reader routes' nonce CSP, `src/proxy.ts`), for `UiRoot`'s script. */
export async function requestNonce(): Promise<string | undefined> {
  return nonceFromCsp((await headers()).get("content-security-policy"));
}
