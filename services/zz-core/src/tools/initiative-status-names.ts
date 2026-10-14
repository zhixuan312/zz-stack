/**
 * `initiative_status` for a page of initiatives: up to ten named ones in one call, each answered
 * exactly as the single-name form answers it.
 *
 * COUPLED: no rule of its own. Every entry is `initiativeState` for that name, from the one
 * `anchorsFor` read the handler made for the whole list, so a page of initiatives and a call per
 * initiative cannot disagree about where any of them stands.
 */
import type pg from "pg";

import { Refusal } from "../refusal.js";
import { safeName } from "../paths.js";

import { anchorsFor, chainArgs, initiativeState } from "./initiative-status.js";

/** The most names one call answers: a page of the console's list. */
const MOST = 10;

type State = Awaited<ReturnType<typeof initiativeState>>;

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

/** Each named initiative's state, in the order asked: what the single-name form answers for it, a
 *  name the team does not hold `no such initiative`, and a `Refusal` from one initiative its text
 *  against that one, so one initiative never takes down the page.
 *
 *  Overlapped as the listing is, a pool's width at a time, with the answers kept in order. */
export async function initiativesNamed(
  p: pg.Pool, team: string, names: readonly string[], anchors: Awaited<ReturnType<typeof anchorsFor>>,
): Promise<{ initiatives: (State | { initiative: string; error: string })[] }> {
  const read = async (name: string): Promise<State | { initiative: string; error: string }> => {
    const anchor = anchors.get(name);
    if (!anchor) return { initiative: name, error: "no such initiative" };
    try {
      return await initiativeState(p, team, name, ...await chainArgs(p, team, name), anchor);
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      return { initiative: name, error: err.message };
    }
  };
  const initiatives: (State | { initiative: string; error: string })[] = [];
  const width = Number(process.env.ZZ_DB_POOL_MAX || 4) || 4;
  for (let i = 0; i < names.length; i += width) {
    initiatives.push(...await Promise.all(names.slice(i, i + width).map(read)));
  }
  return { initiatives };
}
