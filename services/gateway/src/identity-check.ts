/**
 * Prove that a door which says NO ends the request.
 *
 *   npm run check:identity      # exits non-zero on failure, like every engine here
 *
 * `resolveThrough` carries this sentence: "Exported so the ORDERING can be tested, because
 * the property that matters is not visible by reading." It was exported, and nothing tested
 * it — the export existed for a check that was never written, which is the same shape as the
 * markdown renderer beside this file: two real holes found by reading, fixed by reading, and
 * never once run.
 *
 * The property is an authentication bypass, not a tidiness concern. A revoked PAT must 401
 * immediately. If a refusing adapter fell through to the next door instead, the forwarded
 * -header adapter would answer — and a revoked token would become an unauthenticated header
 * claim, which is the exact opposite of having revoked it. Nothing about that is visible in
 * `for (const adapter of adapters)`: the bug is a missing early return, and the code reads
 * identically with and without it.
 *
 * Against the REAL resolveThrough, never a copy of its rules. The adapters are stubs because
 * the production two need a database and a compose network, and neither is the subject here:
 * what is under test is the WALK, and a stub door that refuses is indistinguishable to it
 * from a revoked PAT.
 *
 * BOTH DIRECTIONS, for the reason the markdown corpus has both. A walk that returned the
 * first adapter's answer unconditionally would pass every refusal case above and be useless,
 * and that failure looks exactly like success — so falling through on `null` is a case too.
 */
import type { Request } from "express";

import { type IdentityAdapter, resolveThrough } from "./identity.js";

const req = {} as Request;   // no adapter here reads it; the walk is the subject

/** A door that answers, refuses, or is not this door — and records that it was asked. */
function door(
  name: string, answer: Awaited<ReturnType<IdentityAdapter["resolve"]>>, asked: string[],
): IdentityAdapter {
  return {
    name,
    resolve: (): Promise<Awaited<ReturnType<IdentityAdapter["resolve"]>>> => {
      asked.push(name);
      return Promise.resolve(answer);
    },
  };
}

const identity = {
  email: "someone@example.com", displayName: "Someone", platformRole: "member",
  teams: [], activeTeam: null, via: "pat",
} as unknown as Exclude<Awaited<ReturnType<IdentityAdapter["resolve"]>>, null | { refuse: string }>;

interface Case {
  name: string;
  /** What each door in order answers. */
  doors: (Awaited<ReturnType<IdentityAdapter["resolve"]>>)[];
  /** The doors that must have been ASKED — the ordering property lives here. */
  asked: string[];
  expect: "identity" | "refuse" | "null";
  why: string;
}

const CASES: Case[] = [
  {
    name: "a refusal ends the walk",
    doors: [{ refuse: "invalid, expired or revoked PAT" }, identity],
    asked: ["d0"],
    expect: "refuse",
    why: "the second door must never be asked — that is how a revoked PAT would become a " +
         "forwarded-header claim",
  },
  {
    name: "a door that does not apply falls through",
    doors: [null, identity],
    asked: ["d0", "d1"],
    expect: "identity",
    why: "null means 'not my door'; stopping here would 401 every caller using the second door",
  },
  {
    name: "the first door that answers wins",
    doors: [identity, { refuse: "should never be reached" }],
    asked: ["d0"],
    expect: "identity",
    why: "a later door must not be able to overturn an answer already given",
  },
  {
    name: "a refusal behind a non-applying door still ends the walk",
    doors: [null, { refuse: "invalid, expired or revoked PAT" }, identity],
    asked: ["d0", "d1"],
    expect: "refuse",
    why: "the early return has to survive being reached on a later iteration",
  },
  {
    name: "no door applies",
    doors: [null, null],
    asked: ["d0", "d1"],
    expect: "null",
    why: "null is what the middleware turns into 'authentication required'; a refusal here " +
         "would report a wrong reason and an identity would be an open door",
  },
];

async function main(): Promise<number> {
  const failures: string[] = [];
  for (const c of CASES) {
    const asked: string[] = [];
    const adapters = c.doors.map((a, i) => door(`d${i}`, a, asked));
    const got = await resolveThrough(adapters, req);
    const kind = got === null ? "null" : "refuse" in got ? "refuse" : "identity";
    if (kind !== c.expect) {
      failures.push(`${c.name}: returned ${kind}, expected ${c.expect} — ${c.why}`);
    }
    if (asked.join(",") !== c.asked.join(",")) {
      failures.push(
        `${c.name}: asked [${asked.join(", ")}], expected [${c.asked.join(", ")}] — ${c.why}`);
    }
  }

  if (failures.length) {
    console.error(`\n  identity: ${failures.length} of ${CASES.length} case(s) failed\n`);
    for (const f of failures) console.error(`    ${f}`);
    console.error("");
    return 1;
  }
  console.log(`  identity: ${CASES.length} adapter-walk cases pass — a door that refuses ends ` +
              "the request");
  return 0;
}

process.exit(await main());
