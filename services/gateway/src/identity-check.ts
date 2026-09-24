/**
 * Prove that a door which says no ends the request.
 *
 *   npm run check:identity      # exits non-zero on failure, like every engine here
 *
 * COUPLED: `resolveThrough` is exported from identity.js so this can test its ordering. The
 * property is an authentication bypass: a refusing adapter that fell through would let the
 * forwarded-header adapter answer, turning a revoked token into an unauthenticated header
 * claim. The bug is a missing early return, and the code reads identically with and without
 * it.
 *
 * DELIBERATE: run against the real `resolveThrough`, never a copy of its rules. The adapters
 * are stubs because the production two need a database and a compose network, and what is
 * under test is the walk — to which a stub door that refuses is indistinguishable from a
 * revoked PAT.
 *
 * Both directions are cases: a walk returning the first adapter's answer unconditionally
 * passes every refusal case and is useless, so falling through on `null` is asserted too.
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
  /** The doors that must have been asked — the ordering property lives here. */
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
