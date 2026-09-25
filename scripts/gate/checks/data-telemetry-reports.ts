/**
 * Telemetry: the read side. A field, a column or a header only earns its keep once something
 * depends on it — a report, a count, or the loop that turns evidence into a change. This
 * checks that every reader's field has a writer (and the reverse), that a report counting an
 * activity counts the ones that actually happened, that a live count in a skill says when it
 * was taken, and that the evolution loop which reads all of this closes somewhere.
 *
 * The write side — what the telemetry records in the first place — is
 * checks/data-telemetry.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { between, firstOf, functionBody, root, sourceFiles, withoutComments } from "../read.ts";
import { check } from "../run.ts";

/** A caught value is never typed as an Error — narrow the shape actually being read rather
 *  than assume it. `unknown?.message` narrows to `{}`, which has no properties at all. */
function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as Record<string, unknown>).message;
    if (m !== undefined && m !== null) return String(m);
  }
  return String(err);
}
import { flows, schemaColumns } from "../facts.ts";

check("the evolution loop is closed, and separate from what it measures", () => {
  // Evidence -> which step is not working -> change one thing -> re-verify -> next round.
  // tool-report says which tool is refused; it does not name the step that stalls, which is the
  // form a skill can be edited from.
  //
  // evolve-report attributes each refusal to the skill the agent had loaded when it happened,
  // by trace: skill_read says which skill, and everything after it is done while following
  // that skill. Attribution by document name would be a guess, because a flow may write the
  // same document from more than one step.
  //
  // DELIBERATE: zz-evolve is a platform skill under skills/, never a stage in any flow's
  // manifest. An evaluation whose subject runs it means nothing.
  const bad: string[] = [];
  const tool = join(root, "packages/tools/src/testing/evolve-report.ts");
  if (!existsSync(tool)) {
    bad.push("evolve-report is missing — nothing says which STEP stalls");
  } else {
    const src = readFileSync(tool, "utf8");
    // The attribution expression, not the words: a test for the string "skill_view" also
    // passes on `skill_view_disabled`.
    //
    // Attribution is a column — the gateway decides which step a call belonged to at the door
    // and stores it, so the report reads `e.step` rather than replaying skill loads per caller.
    // Both legs are required: without the column the report is guessing, and without the trace
    // fallback the history written before the column becomes unreadable.
    if (!/const stamped = e\.step/.test(src) || !/following\.set\(e\.caller/.test(src)) {
      bad.push("evolve-report no longer attributes refusals to the skill being followed");
    }
    if (!/refusalClass/.test(src)) {
      bad.push("evolve-report no longer groups refusals by class — raw texts do not rank");
    }
  }
  // The loop closes outside any skill: the report specifies the change and a release applies
  // it. So the report has to say so — one change, the expected effect written down, and the
  // route named. A recommendation that does not say what it expects cannot be contradicted by
  // the next round, and gets read as agreement whatever that round says.
  const report = join(root, "catalog/zz/zz-plugin-eval/skills/zz-plugin-explain/SKILL.md");
  if (!existsSync(report)) {
    bad.push("zz-plugin-explain is missing — nothing specifies the change the evidence calls for");
  } else {
    const r = readFileSync(report, "utf8");
    if (!/ONE CHANGE, AND SAY WHAT YOU EXPECT IT TO DO/.test(r)) {
      bad.push("zz-plugin-explain no longer requires one change with its expected effect — " +
               "two changes in a round make the next round unable to attribute either, and a " +
               "recommendation with no expectation cannot be contradicted");
    }
    if (!/release/i.test(r)) {
      bad.push("zz-plugin-explain no longer names how a change actually ships — the catalog is " +
               "read-only at runtime, so a recommendation that does not say 'repository and " +
               "release' dead-ends");
    }
  }
  // Never a stage of a flow, whatever it is called: that installs the change beside its own
  // measurement. Held against the retired name too, so restoring it as a stage still fails.
  for (const f of flows) {
    const m = JSON.parse(readFileSync(join(f.dir, "flow.json"), "utf8"));
    if ((m.stages ?? []).some((x: { name: string }) => x.name === "zz-skill-evolve")
        || Object.values(m.commands ?? {}).includes("zz-skill-evolve")) {
      bad.push(`${f.owner}/${f.flow} lists zz-skill-evolve — the measured must not run the measure`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

// Provenance that nothing can read answers nothing.
//
// The other half of the column rule: "a column the platform enforces is a column something can
// write" catches a guard with no writer; this catches a writer with no reader. Provenance
// recorded where nobody can reach it answers the same as not having recorded it.
//
// Only the `_by` columns. Every column has to be written; not every column is a claim about
// who did something, and a claim about who did something exists to be read back.
check("provenance the platform records is provenance something reads", () => {
  const src = sourceFiles(["services", "packages"], [".ts"])
    .map((f) => readFileSync(join(root, f), "utf8"));
  const bad: string[] = [];
  for (const c of schemaColumns()) {
    const col = c.split(".")[1];
    if (!/_by$/.test(col)) continue;
    let written = false, read = false;
    for (const text of src) {
      for (const line of text.split("\n")) {
        if (!new RegExp(`\\b${col}\\b`).test(line)) continue;
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        if (/insert into|\bset\b[^;]*=|putEnvelopeField|\$\{/.test(line)) written = true;
        if (/\bselect\b|\bas \w+|\.[a-z_]+\b|\bwhere\b/.test(line)) read = true;
      }
    }
    if (written && !read) {
      bad.push(`${c} is written on every row and read by nothing — the question it exists to ` +
               "answer can only be answered by opening the database");
    }
  }
  return bad.join("\n");
});

// A report that counts calls to one tool counts the ones that succeeded: a refused call is not
// the activity it names.
check("a report counting an activity counts the ones that happened", () => {
  const bad: string[] = [];
  for (const rel of sourceFiles(["packages/tools/src"], [".ts"])) {
    const lines = readFileSync(join(root, rel), "utf8").split("\n");
    lines.forEach((line, i) => {
      // A condition naming one tool: `tool === "x"` or `subject.endsWith(":x")`.
      if (!/tool === "[a-z_]+"|subject\.endsWith\(":[a-z_]+"/.test(line)) return;
      if (!/^\s*(if|\} else if)\b/.test(line)) return;
      // Counting failures is what these are for.
      if (/refusal|unreadable|aborted|\bms\b|!\s*\w+\.ok/.test(line)) return;
      // Does it lead to a count? Look at the condition and the two lines under it.
      const body = [line, lines[i + 1] ?? "", lines[i + 2] ?? ""].join(" ");
      if (!/\+= 1|\+\+|\?\? 0\) \+ 1/.test(body)) return;
      if (/\.ok\b/.test(line)) return;
      bad.push(`${rel}:${i + 1} counts ${line.trim().slice(0, 70)}` +
               ` without asking whether it succeeded`);
    });
  }
  return bad.join("\n");
});

check("a telemetry field a report reads is a field something writes", () => {
  // A reader may not depend on a column no writer sets. watch-results builds "a team has gone
  // quiet" from the distinct teams in the window, so an unwritten zz.event.team_slug reads
  // exactly like a quiet platform.
  //
  // The invariant is not "every writer attributes": several logEvent call sites write no team
  // and are right to, since a self-issued PAT and a package download belong to a person rather
  // than a team. It is that a reader of team_slug must be reading kinds that something
  // attributes.
  const bad: string[] = [];
  const attributed = new Set(), unattributed = new Set();
  let dynamic = 0;

  for (const rel of sourceFiles(["services", "packages"], [".ts"])) {
    const src = withoutComments(readFileSync(join(root, rel), "utf8"));
    for (const m of src.matchAll(/logEvent\(\{/g)) {
      let depth = 0, i = src.indexOf("{", m.index);
      for (; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) break;
      }
      const call = src.slice(m.index, i + 1);
      const kind = /kind:\s*"([a-z_.]+)"/.exec(call)?.[1];
      // A kind built from a variable cannot be resolved here, and guessing at one would be
      // the same error as the hand-written list this replaced. Counted, so "no kinds found"
      // and "every kind is dynamic" are told apart below.
      if (!kind) { dynamic++; continue; }
      (/teamSlug\s*:/.test(call) ? attributed : unattributed).add(kind);
    }
    // Raw SQL writers too: a statement that inserts into zz.event directly never touches
    // logEvent, so a check reading only the helper would call its kinds unwritten.
    for (const m of src.matchAll(/insert into (?:zz\.)?event\s*\(([^)]*)\)([\s\S]{0,400})/g)) {
      const cols = m[1];
      for (const k of m[2].matchAll(/'([a-z_.]+)'/g)) {
        (/team_slug/.test(cols) ? attributed : unattributed).add(k[1]);
      }
    }
  }
  if (!attributed.size && !unattributed.size && !dynamic) {
    return "no zz.event writer found at all — this check cannot run";
  }

  // Readers. The SQL is assembled from adjacent string literals, so the seam is removed first
  // or `select … team_slug` and the `where kind = …` that scopes it sit on different lines.
  for (const rel of sourceFiles(["services", "packages"], [".ts"])) {
    const src = withoutComments(readFileSync(join(root, rel), "utf8"))
      .replace(/"\s*\+\s*\n?\s*"/g, "");
    for (const m of src.matchAll(/select\s[^;"`]*?\bteam_slug\b[^;"`]*?from\s+zz\.event([^;"`]*)/gi)) {
      const line = src.slice(0, m.index).split("\n").length;
      const kinds = [...m[1].matchAll(/kind\s*=\s*'([a-z_.]+)'/gi)].map((k) => k[1]);
      if (!kinds.length) {
        bad.push(`${rel}:${line} selects team_slug from zz.event without scoping to a kind — ` +
                 "some kinds are written by acts that belong to a person and not a team");
        continue;
      }
      for (const k of kinds) {
        if (attributed.has(k)) continue;
        bad.push(`${rel}:${line} reads team_slug for kind '${k}', which ` +
                 (unattributed.has(k) ? "is written with no team — every such row reads as unattributed"
                                      : "nothing in this repository writes"));
      }
    }
  }
  return bad.length ? firstOf(bad) : null;
});

check("a count of what is on this deployment says when it was counted", () => {
  // A skill stating a live count in the present tense rots as the data grows.
  //
  // Whitespace is normalised, which is why this is a check rather than a grep: a count wrapped
  // across two lines is invisible to a line-oriented sweep.
  //
  // A count, not any mention. "there is an initiative on this deployment in that state" is an
  // existence claim that stays true as the data grows; "of the eleven nodes" does not.
  const NUM = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i;
  // What makes a count honest: a date, or wording that puts it in the past on purpose.
  const DATED = /\d{4}-\d{2}-\d{2}|that existed|when the check was added|at the time|measured on|as of/i;
  const findings = [];
  for (const rel of sourceFiles(["catalog", "skills", "docs"], [".md"])) {
    const flat = readFileSync(join(root, rel), "utf8").replace(/\s+/g, " ");
    for (const m of flat.matchAll(/[^.!?]*\bthis deployment\b[^.!?]*[.!?]/gi)) {
      const sentence = m[0];
      if (!NUM.test(sentence)) continue;          // an existence claim, not a count
      if (DATED.test(sentence)) continue;         // says when, which is the whole ask
      findings.push(`${rel}: ${sentence.trim().slice(0, 110)}`);
    }
  }
  return firstOf(findings) &&
    `${firstOf(findings)} — a count of live data read as current forever; give it a date or ` +
    "say it is the count from when the rule was written";
});

check("whether a refusal taught anything is one judgement", () => {
  // A refusal must teach the rule: no silent coercion, no bare status codes.
  // COUPLED: one implementation, packages/tools/src/lib/refusal.ts, answers it wherever it is
  // asked.
  //
  // A length floor gets it wrong: "RPC ERROR: request failed with status code 422" is
  // forty-six characters and teaches nothing, and `RPC ERROR: ` is the prefix the engine adds
  // to every JSON-RPC error itself.
  //
  // Run, over the messages that separate the two readings.
  const src = readFileSync(join(root, "packages/tools/src/lib/refusal.ts"), "utf8");
  const body = functionBody(src, "teachesTheRule");
  if (!body) return "packages/tools no longer defines teachesTheRule — this check cannot run";
  let teaches;
  try {
    // FILLER is the module constant the body closes over.
    const filler = [...(/const FILLER = new Set\(\[([\s\S]*?)\]\)/.exec(src)?.[1] ?? "")
      .matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    if (!filler.length) return "FILLER cannot be read from lib/refusal.ts";
    teaches = new Function("FILLER", "text", body).bind(null, new Set(filler));
  } catch (err) {
    return `teachesTheRule could not be evaluated: ${errMessage(err)}`;
  }

  const bad: string[] = [];
  const cases = [
    ["422", false],
    ["Request failed with status code 422", false],
    ["RPC ERROR: request failed with status code 422", false],
    ["  RPC ERROR: Request failed with status code 422  ", false],
    ["500", false],
    // Two words to act on is not a rule either. This is where the threshold lives, and where
    // a length floor gets it wrong in the other direction.
    ["Not Found", false],
    ["app_variable name must be lowercase letters and underscores", true],
    ["ERROR: spec.md is missing the section `## Decisions`", true],
  ];
  for (const [text, want] of cases) {
    if (Boolean(teaches(text)) !== want) {
      bad.push(`teachesTheRule(${JSON.stringify(text)}) is ${!want} and should be ${want}`);
    }
  }

  // And nobody keeps a second copy. A length floor is the shape the other one had.
  for (const rel of sourceFiles(["packages/tools"], [".ts"])) {
    if (rel.endsWith("lib/refusal.ts")) continue;
    const text = readFileSync(join(root, rel), "utf8");
    if (/function teaches\b|const teaches =\s*\(/.test(text)) {
      bad.push(`${rel} defines its own \`teaches\` — R6 is one judgement, in lib/refusal.ts`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("every field the tool telemetry writes has a reader", () => {
  // Both sides of the same rule: a field written on every row and read by nobody is capture
  // nobody asked for, and a reader with no field is a question that looks answered.
  //
  // The measurement fields live in two places — real columns for what anybody groups by,
  // declared on logEvent's parameter, and the `detail` bag for what is read once and never
  // filtered on. Both are compared. The envelope's own plumbing is not: `actor`, `kind`,
  // `subject`, `teamSlug` and `detail` describe the row rather than the measurement, and every
  // kind of event carries them.
  const src = readFileSync(join(root, "services/gateway/src/tool-telemetry.ts"), "utf8");
  const events = readFileSync(join(root, "services/gateway/src/events.ts"), "utf8");
  const report = readFileSync(join(root, "packages/tools/src/testing/tool-report.ts"), "utf8");

  // `true` is not a field. `{ unreadable: true }` and `{ aborted: true }` put a literal where
  // the shorthand pattern expects a name, and a check that reports `true` as an unread capture
  // is noise that trains the reader to skip the line.
  const PLUMBING = new Set(["actor", "kind", "subject", "teamslug", "detail", "ts", "true", "false"]);
  const norm = (k: string): string => k.toLowerCase().replace(/_/g, "");

  // The columns, from the one declaration that lists them.
  const sig = between(withoutComments(events), "export function logEvent(e: {", "\n}): void {");
  if (!sig.text) return `logEvent's parameter cannot be located: ${sig.why}`;
  const columns = new Set([...sig.text.matchAll(/^\s{2}([A-Za-z_]+)\??:/gm)]
    .map((m) => norm(m[1])).filter((k) => !PLUMBING.has(k)));
  if (!columns.size) return "logEvent declares no measurement columns — the shape moved";

  // The bag, from the call site that fills it.
  const kindAt = src.indexOf('kind: "tool_call",');
  if (kindAt < 0) return "tool-telemetry no longer writes a tool call — this check cannot run";
  const bag = between(withoutComments(src).slice(withoutComments(src).indexOf('kind: "tool_call",')),
                      "detail: {", "\n          },");
  if (!bag.text) return `the tool_call detail cannot be located: ${bag.why}`;
  // Without comments: a word followed by a colon in a sentence reads exactly like a key.
  // Shorthand counts: `ms,` and `bytes,` are properties as much as `caller: callerHash` is, and
  // `{ ids }` inside a conditional spread is one too.
  const written = new Set([...bag.text.matchAll(/(?:^|[{\s])([a-z_]+)\s*(?::|,|\s*\})/gm)]
    .map((m) => norm(m[1])).filter((k) => !PLUMBING.has(k)));
  for (const c of columns) written.add(c);

  // The reader: its interface, columns and bag alike.
  const iface = between(withoutComments(report), "interface CallRow {", "\n}\n");
  if (!iface.text) return "tool-report no longer declares the call row it reads";
  const declared = new Set([...iface.text.matchAll(/^\s+([a-z_]+)\??:/gm)]
    .map((m) => norm(m[1])).filter((k) => !PLUMBING.has(k)));
  if (!declared.size) return "tool-report declares no fields — the shape moved";

  const bad: string[] = [];
  for (const f of [...written].sort()) {
    if (!declared.has(f)) {
      bad.push(`the telemetry writes \`${f}\` on every tool call and tool-report declares no ` +
               "such field — a capture with no reader is a question that stays unanswerable");
    }
  }
  for (const f of [...declared].sort()) {
    if (!written.has(f)) bad.push(`tool-report reads \`${f}\` and the telemetry writes no such field`);
  }
  return bad.length ? bad.join("; ") : null;
});
