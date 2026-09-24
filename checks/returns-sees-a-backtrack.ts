// Does the returns derivation see a return at all? A derivation that groups by
// (initiative, step) and takes min(ts) collapses every visit into one row and is monotonic by
// construction, so it reports zero however many returns there are.
//
// DELIBERATE: it plants a backtrack in a rolled-back transaction on the live database, because
// the shape being tested is SQL and the gate cannot reach a database. Read-only in effect.
import { execFileSync } from "node:child_process";

function fail(m: string): never { console.error("FAIL: " + m); process.exit(1); }
const psql = (sql: string) => execFileSync("ssh", ["-o", "ConnectTimeout=30", "zz-stack",
  `docker exec -i $(docker ps -qf name=postgres|head -1) psql -U zz -d zz -v ON_ERROR_STOP=1 -tAq`],
  { input: sql, encoding: "utf8" });

// spec -> audit -> spec. DELIBERATE: the repeat is not adjacent, because a naive DISTINCT
// would already collapse adjacent repeats correctly.
const ISLANDS = `
  select step from (
    select e.initiative, e.step, e.ts,
           row_number() over (partition by e.initiative order by e.ts)
         - row_number() over (partition by e.initiative, e.step order by e.ts) as visit
      from zz.event e
     where e.initiative = 'probe-backtrack' and e.step is not null and e.step <> '') x
   group by initiative, step, visit
   order by min(ts)`;

const out = psql(`
begin;
insert into zz.event (actor, team_slug, kind, subject, initiative, step, ts) values
  ('probe','zz-platform','tool_call','x','probe-backtrack','sdlc-spec',       now() - interval '3 min'),
  ('probe','zz-platform','tool_call','x','probe-backtrack','sdlc-spec-audit', now() - interval '2 min'),
  ('probe','zz-platform','tool_call','x','probe-backtrack','sdlc-spec',       now() - interval '1 min');
${ISLANDS};
rollback;
`);

const seq = out.split("\n").map((s) => s.trim()).filter(Boolean);
if (seq.length !== 3) {
  fail(`the islands query returned ${seq.length} visit(s), not 3: ${JSON.stringify(seq)} — a ` +
       "step entered twice with another between them must be TWO rows, or no return is visible");
}
if (!(seq[0] === "sdlc-spec" && seq[1] === "sdlc-spec-audit" && seq[2] === "sdlc-spec")) {
  fail(`the visit order is ${JSON.stringify(seq)}, not spec -> audit -> spec`);
}

// And the derivation over that sequence: a step whose declared position precedes one already
// seen. The stage order is sdlc-flow's, flattened to the three that matter here.
const stages = ["sdlc-explore", "sdlc-spec", "sdlc-spec-audit", "sdlc-plan"];
const at = new Map(stages.map((s, i) => [s, i]));
let furthest = -1, returns = 0;
for (const step of seq) {
  const pos = at.get(step);
  if (pos === undefined) continue;
  if (pos < furthest) returns++; else furthest = pos;
}
if (returns !== 1) fail(`the derivation found ${returns} return(s) in spec -> audit -> spec, expected 1`);

console.log("PASS: three visits from three events, and one return derived from them.");
