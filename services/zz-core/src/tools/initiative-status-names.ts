/**
 * `initiative_status` for a page of initiatives: up to ten named ones in one call, each answered
 * exactly as the single-name form answers it.
 *
 * COUPLED: no rule of its own. Every entry is `initiativeState` for that name, from the one
 * `anchorsFor` read the handler made for the whole list, so a page of initiatives and a call per
 * initiative cannot disagree about where any of them stands.
 */
import type pg from "pg";

import { safeName } from "../paths.js";

import { anchorsFor, statesFor } from "./initiative-status.js";

/** The most names one call answers: a page of the console's list. */
const MOST = 10;

/** The names form's refusal, or null when `names` may be read: a list of one to ten single names. */
export function namesRefusal(names: readonly string[]): string | null {
  if (!names.length) return "ERROR: `initiatives` names no initiative — name one to ten, or omit it.";
  if (names.length > MOST) {
    return `ERROR: \`initiatives\` names ${names.length} initiatives; one call answers at most ${MOST}.`;
  }
  for (const name of names) {
    const bad = safeName(name, "a name in `initiatives`");
    if (bad) return bad;
  }
  return null;
}

/** Each named initiative's state, in the order asked: what the single-name form answers for it,
 *  through the same `statesFor` the listing reads. */
export async function initiativesNamed(
  p: pg.Pool, team: string, names: readonly string[], anchors: Awaited<ReturnType<typeof anchorsFor>>,
): Promise<{ initiatives: Awaited<ReturnType<typeof statesFor>> }> {
  return { initiatives: await statesFor(p, team, names, anchors) };
}
