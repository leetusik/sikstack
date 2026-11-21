import Link from "next/link";

import { agendaHref, agendaItemHref } from "@/lib/workspace/address";

import { PROJECT, RECORDING } from "../lib/recording";

// The design build's index: its pages, each at production's address.
export const metadata = { title: "Design" };

export default function DesignIndex() {
  const first = RECORDING.workspace.agenda[0];
  return (
    <main style={{ padding: 32, fontFamily: "var(--font-plex-sans), sans-serif" }}>
      <h1>sikstack design build</h1>
      <p>Recording: {RECORDING.name}</p>
      <ul>
        <li>
          <Link href={agendaHref(PROJECT)}>Workspace · Agenda</Link>
        </li>
        {first ? (
          <li>
            <Link href={agendaItemHref(PROJECT, first.id, null)}>Agenda item · {first.id}</Link>
          </li>
        ) : null}
      </ul>
    </main>
  );
}
