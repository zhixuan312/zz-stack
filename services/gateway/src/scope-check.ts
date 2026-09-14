/**
 * Prove that resolveScope never returns "no scope" — only a team, the platform, or a
 * refusal.
 *
 *   npm run check:scope      # exits non-zero on failure, like every engine here
 *
 * The console's live SQL still has the null-wildcard shape resolveScope exists to replace —
 * `where ($1::text is null or team_slug = $1)` reads every team when the parameter is
 * absent. This check is the standing evidence that the replacement never does that: it
 * drives the REAL resolveScope, never a copy of its branches, over the ten cases the
 * contract names — one team, two teams with no parameter, picking the second team
 * explicitly, naming a team not joined, a malformed slug, a non-superadmin asking for the
 * platform, a superadmin's default, a superadmin asking for the platform, a superadmin
 * naming a team they do not belong to, and a caller in no team at all. Between them every
 * branch of the union is reached from both a member and a superadmin, and the one case that
 * must NEVER happen — a non-superadmin reaching platform scope — is asserted against
 * directly rather than left as an absence, so it stays proven when console.ts is rewired
 * onto this function.
 *
 * Task I-14 adds a second matrix below, driving `teamAuthority` (admin.ts) — the function
 * settings.ts's `/api/console/settings/team/*` routes and every admin.ts team-write tool
 * both call, rather than a comparison written out at either call site.
 */
import type { Request } from "express";

import { resolveScope, type Scope } from "./scope.js";
import { isSuper, type Identity } from "./identity.js";
import { superOnly, teamAuthority } from "./admin/authority.js";

/** Build an Identity fixture without repeating the fields every case doesn't care about. */
function identity(over: Partial<Identity>): Identity {
  return {
    email: "someone@example.com",
    displayName: "Someone",
    platformRole: "member",
    teams: [],
    activeTeam: null,
    via: "forwarded",
    ...over,
  };
}

/** A request carrying only what resolveScope reads — no method, no headers, no res. */
function request(query: Record<string, string>): Request {
  return { query } as unknown as Request;
}

interface Case {
  name: string;
  id: Identity;
  query: Record<string, string>;
  expect: Scope;
  why: string;
}

const oneTeam = identity({
  teams: [{ slug: "team_one", role: "member" }],
  activeTeam: "team_one",
});

const twoTeams = identity({
  teams: [
    { slug: "team_one", role: "member" },
    { slug: "product_group_2", role: "member" },
  ],
  activeTeam: "team_one",
});

const superadmin = identity({
  platformRole: "superadmin",
  teams: [{ slug: "zz-platform", role: "admin" }],
  activeTeam: "zz-platform",
});

const noTeams = identity({ teams: [], activeTeam: null });

const CASES: Case[] = [
  {
    name: "a member with one team",
    id: oneTeam,
    query: {},
    expect: { kind: "team", slug: "team_one" },
    why: "the only team they have is also their activeTeam — nothing to choose between",
  },
  {
    name: "a member with two teams and no parameter",
    id: twoTeams,
    query: {},
    expect: { kind: "team", slug: "team_one" },
    why: "no ?team= must fall back to activeTeam, the ONE team the platform says they are " +
         "acting as — not the first or last row of `teams`",
  },
  {
    name: "a member selecting their second team by parameter",
    id: twoTeams,
    query: { team: "product_group_2" },
    expect: { kind: "team", slug: "product_group_2" },
    why: "?team= must be able to override activeTeam for a caller who belongs to the team " +
         "named",
  },
  {
    name: "a member naming a team they do not belong to",
    id: oneTeam,
    query: { team: "product_group_9" },
    expect: { kind: "refused", status: 403, error: "not a member of product_group_9" },
    why: "membership is the whole point of team scope; a non-member reading it is the exact " +
         "leak this module exists to refuse",
  },
  {
    name: "a member sending the platform-scope parameter",
    id: oneTeam,
    query: { scope: "platform" },
    expect: { kind: "team", slug: "team_one" },
    why: "a non-superadmin asking for platform scope is not an error — it must fall through " +
         "to team scope silently, with nothing in the response disclosing that the " +
         "parameter exists or what it would have done for someone else",
  },
  {
    name: "a superadmin with no parameter",
    id: superadmin,
    query: {},
    expect: { kind: "team", slug: "zz-platform" },
    why: "platform authority is not automatic scope — a superadmin who asks for nothing " +
         "gets their own team, exactly like anyone else",
  },
  {
    name: "a superadmin with the platform parameter",
    id: superadmin,
    query: { scope: "platform" },
    expect: { kind: "platform" },
    why: "platform scope exists for exactly this caller, and only this caller",
  },
  {
    name: "a caller with no teams at all",
    id: noTeams,
    query: {},
    expect: { kind: "refused", status: 400, error: "no team — join a team or pass ?team=" },
    why: "there is no activeTeam to fall back to and no ?team= to try — the refusal has to " +
         "name the fix rather than 500 on an undefined slug",
  },
  {
    name: "a member sending a malformed slug",
    id: oneTeam,
    query: { team: "Team One" },
    expect: { kind: "refused", status: 400, error: "team must be a slug" },
    why: "checked before membership, so a string that was never a slug gets \"team must be " +
         "a slug\" rather than a misleading \"not a member of Team One\"",
  },
  {
    name: "a superadmin naming a team they do not belong to",
    id: identity({
      platformRole: "superadmin",
      teams: [{ slug: "zz-platform", role: "admin" }],
      activeTeam: "zz-platform",
    }),
    query: { team: "team_one" },
    expect: { kind: "team", slug: "team_one" },
    why: "a superadmin's whole point is reading a team they do not belong to — the " +
         "membership check must not refuse them the way it refuses a member",
  },
];

function same(got: Scope, want: Scope): boolean {
  return JSON.stringify(got) === JSON.stringify(want);
}

/**
 * The team-authority matrix (← Task I-14, AC-5): who may add, remove or change the role of
 * a team's members, or install and uninstall its flows. Drives `teamAuthority` itself,
 * exported from admin.ts, rather than a second copy of "team admin or superadmin" — a check
 * that re-implemented the comparison would still pass if the real function drifted from it.
 *
 * The fifth case is the one worth having this matrix for: a superadmin whose TOKEN is
 * bound to one team carries no authority anywhere else, including a team that same person
 * could reach with an unbound token. `isSuper` (identity.ts) is where that is decided —
 * `id.via === "pat" && id.patTeam` returns false before `platformRole` is even read — and
 * `isTeamAdmin` calls `isSuper` first, so this case is really proving the two functions
 * still agree, not proving either one in isolation.
 */
interface TeamAuthorityCase {
  name: string;
  id: Identity;
  team: string;
  expect: boolean;
  why: string;
}

const teamAdminOfP1 = identity({
  teams: [{ slug: "team_one", role: "admin" }],
  activeTeam: "team_one",
});

const memberOfP1 = identity({
  teams: [{ slug: "team_one", role: "member" }],
  activeTeam: "team_one",
});

const teamAdminOfP2 = identity({
  teams: [{ slug: "product_group_2", role: "admin" }],
  activeTeam: "product_group_2",
});

const superadminBoundToP2 = identity({
  platformRole: "superadmin",
  teams: [{ slug: "product_group_2", role: "admin" }],
  activeTeam: "product_group_2",
  via: "pat",
  patTeam: "product_group_2",
});

const TEAM_AUTHORITY_CASES: TeamAuthorityCase[] = [
  {
    name: "a team admin on their own team",
    id: teamAdminOfP1, team: "team_one", expect: true,
    why: "an admin of the team named is exactly who member_add, flow_install and their " +
         "console-side routes exist for",
  },
  {
    name: "a plain member of that team",
    id: memberOfP1, team: "team_one", expect: false,
    why: "membership is not administration — a member changing their own team's roster " +
         "or flows is exactly the escalation this function exists to refuse",
  },
  {
    name: "a team admin of a different team",
    id: teamAdminOfP2, team: "team_one", expect: false,
    why: "administering one team grants nothing about another — the console's own control-" +
         "hiding rule (me.teams.some(...)) depends on this staying false",
  },
  {
    name: "a superadmin",
    id: superadmin, team: "team_one", expect: true,
    why: "a superadmin is every team, the same rule isTeamAdmin states for its own reason",
  },
  {
    name: "a superadmin holding a team-bound PAT for another team",
    id: superadminBoundToP2, team: "team_one", expect: false,
    why: "isSuper returns false the moment a PAT names a team — a token deliberately " +
         "confined to product_group_2 must not reach back into platform authority for a " +
         "team it was never bound to, which a naive `platformRole === \"superadmin\"` " +
         "comparison would miss entirely",
  },
];

/**
 * The platform-authority matrix (← Task I-15, AC-5): who may add or deactivate a person,
 * create or archive a team, or grant/revoke a team's block access. Drives `superOnly` itself,
 * exported from admin.ts, rather than a second copy of "superadmin required" — a check that
 * re-implemented the comparison would still pass if the real function drifted from it, which
 * is exactly the inline `platformRole === "superadmin"` bug this platform already fixed once
 * (see this file's header comment on `superOnly` in admin.ts).
 *
 * Reuses the same four identities `TEAM_AUTHORITY_CASES` proves `teamAuthority` against —
 * `superOnly` is a strictly narrower rule (no team named, ever permitted), so the same
 * fixtures settle both matrices without a second set drifting from the first.
 */
interface PlatformAuthorityCase {
  name: string;
  id: Identity;
  expect: boolean;
  why: string;
}

const PLATFORM_AUTHORITY_CASES: PlatformAuthorityCase[] = [
  {
    name: "a superadmin",
    id: superadmin, expect: true,
    why: "person_add, team_create and tool_grant all exist for exactly this caller",
  },
  {
    name: "a team admin",
    id: teamAdminOfP1, expect: false,
    why: "administering a team is not platform authority — a team admin granting their own " +
         "team a block, or another team's admin status, is exactly the escalation superOnly " +
         "exists to refuse",
  },
  {
    name: "a plain member",
    id: memberOfP1, expect: false,
    why: "a member has no administrative authority anywhere on the platform",
  },
  {
    name: "a superadmin holding a team-bound PAT",
    id: superadminBoundToP2, expect: false,
    why: "isSuper returns false the moment a PAT names a team — a token deliberately " +
         "confined to product_group_2 must not reach platform-wide authority, which a naive " +
         "`platformRole === \"superadmin\"` comparison would miss entirely",
  },
];

function main(): number {
  const failures: string[] = [];
  for (const c of CASES) {
    const got = resolveScope(c.id, request(c.query));
    if (!same(got, c.expect)) {
      failures.push(
        `${c.name}: got ${JSON.stringify(got)}, expected ${JSON.stringify(c.expect)} — ${c.why}`);
    }
  }
  // The one invariant no single case states on its own: run every case again and confirm a
  // non-superadmin NEVER comes back "platform", whatever they asked for. A regression that
  // grants platform scope to a member would still pass each case above if it also broke
  // something else about that case's expectation — this checks the property directly.
  for (const c of CASES) {
    if (isSuper(c.id)) continue;
    const got = resolveScope(c.id, request({ ...c.query, scope: "platform" }));
    if (got.kind === "platform") {
      failures.push(`${c.name}: a non-superadmin reached platform scope by asking for it`);
    }
  }

  for (const c of TEAM_AUTHORITY_CASES) {
    const got = teamAuthority(c.id, c.team);
    if (got !== c.expect) {
      failures.push(`${c.name}: got ${got}, expected ${c.expect} — ${c.why}`);
    }
  }

  for (const c of PLATFORM_AUTHORITY_CASES) {
    const got = superOnly(c.id);
    if (got !== c.expect) {
      failures.push(`${c.name}: got ${got}, expected ${c.expect} — ${c.why}`);
    }
  }

  if (failures.length) {
    console.error(`\n  scope: ${failures.length} case(s) failed\n`);
    for (const f of failures) console.error(`    ${f}`);
    console.error("");
    return 1;
  }
  console.log(`  scope: ${CASES.length} scope cases, ${TEAM_AUTHORITY_CASES.length} ` +
              `team-authority cases and ${PLATFORM_AUTHORITY_CASES.length} platform-authority ` +
              "cases pass — resolveScope never returns an unscoped identity, never grants " +
              "platform scope to a non-superadmin, teamAuthority permits only that team's " +
              "admin or a superadmin unbound to another team, and superOnly permits only an " +
              "unbound superadmin");
  return 0;
}

process.exit(main());
