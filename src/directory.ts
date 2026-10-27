// The agents of this workspace by name, for the owner's English rule box (`rule_compose`). The SDK hands the full agent list
// to `events.agentsChanged` once after boot and whenever it changes (`needsAgentDirectory: true`); the person op
// `tb.agents_list` reads the same slice list. Kept in memory only (per database), never in a table: it is a lookup aid for
// names, never a fact a rule decides on (rules store agent ids).
import type { Db } from "@opt2-tealbrick/miniapp-sdk";

export interface NamedAgent {
  id: string;
  name: string;
}

const known = new WeakMap<Db, readonly NamedAgent[]>();

/** Keep the latest agent list (ids and display names) of this database's workspace. */
export function rememberAgents(db: Db, agents: readonly { id: string; name?: string | null }[]): void {
  known.set(
    db,
    agents.filter((a) => typeof a.id === "string" && a.id).map((a) => ({ id: a.id, name: typeof a.name === "string" && a.name.trim() ? a.name.trim() : a.id })),
  );
}

/** The latest agent list, or [] before the SDK handed one over (app-alone mode has none). */
export function knownAgents(db: Db): readonly NamedAgent[] {
  return known.get(db) ?? [];
}
