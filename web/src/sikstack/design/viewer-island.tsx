"use client";

import { useState } from "react";

import { shareDesignBuild } from "@/lib/design/actions";

import type { DesignBuild, DesignManifest } from "./model";
import { DesignBuildView } from "./viewer";

/**
 * The viewer's island in production: `DesignBuildView` with its share change sent through the server action
 * (`shareDesignBuild`). While a change is on its way the button shows its busy label and both wait; the
 * answer's build is drawn (its link on, a new link, or off). A 409 (a private build) draws the one line in
 * place of the control; any other failure, a send that threw included, one line under it.
 */
export function DesignViewer({
  project,
  scope,
  build,
  manifest,
  origin,
  timeZone,
  now,
}: {
  project: string;
  scope?: "round" | "all";
  build: DesignBuild;
  manifest: DesignManifest;
  origin: string | null;
  timeZone?: string;
  now?: number;
}) {
  const [share, setShare] = useState({ on: build.share.on, url: build.share.url ?? null });
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const [failed, setFailed] = useState(false);

  async function onShare(on: boolean) {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const answer = await shareDesignBuild(project, build.id, on);
      if (answer.ok) setShare({ on: answer.build.share.on, url: answer.build.share.url ?? null });
      else if (answer.reason === "private") setRefused(true);
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DesignBuildView
      project={project}
      scope={scope}
      build={build}
      manifest={manifest}
      share={share}
      busy={busy}
      onShare={(on) => void onShare(on)}
      refused={refused}
      failed={failed}
      origin={origin}
      timeZone={timeZone}
      now={now}
    />
  );
}
