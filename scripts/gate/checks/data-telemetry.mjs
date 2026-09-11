/**
 * Telemetry: that every field written has a reader, every field read has a writer, and every
 * identifier kept is one a tool can actually send.
 *
 * Telemetry fails in one direction more than any other — a report reading a field nothing
 * writes shows an empty column, which reads as "nothing happened" rather than "nobody wrote
 * this". Both directions are checked here.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { COMMENTS, between, firstOf, functionBody, root, sourceFiles, toolsIn, withoutComments, zzCoreSource, zzCoreTools } from "../read.mjs";
import { check } from "../run.mjs";
import { flows, schemaColumns } from "../facts.mjs";

check("a tool that changes something records that it did", () => {
  // Provenance is one of the platform's permanents, and principle 6 says evidence must be
  // produced mechanically. A mutation nobody recorded is a fact about the platform that can
  // only be recovered by reading the state it changed.
  //
  // set_my_credential and delete_my_credential were the gap, and the shape of it is what
  // makes it worth a check: their OPERATOR twins — admin_set_credential,
  // admin_delete_credential — both logged an event, so the same change to the same store was
  // recorded when an operator made it and invisible when the person made it themselves. The
  // audited path was the rare one; the unaudited path is how almost every key is stored. So
  // "who holds a key for casebox, and since when" could only be answered by opening a file that
  // holds those keys in plaintext.
  //
  // The key itself is never recorded, and that is not what this asks for: THAT a credential
  // changed is provenance, its value is not.
  const MUTATES = /\b(writeFileSync|appendFileSync|withCredentials\(|insert into|update zz\.|delete from)/i;
  const RECORDS = /\b(logActivity\(|auditAdmin\(|logEvent\(|commitStore\()/;
  const bad = [];
  // Every file that registers a tool, found by asking which ones do. Naming the three that
  // register them today is a list that is correct until somebody adds a fourth door, and the
  // whole subject of this check is a tool nobody thought to look at.
  for (const f of sourceFiles(["services"], [".ts"])) {
    const src = readFileSync(join(root, f), "utf8");
    for (const { name, body } of toolsIn(src)) {
      if (MUTATES.test(body) && !RECORDS.test(body)) {
        bad.push(`${name} changes state and records nothing`);
      }
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("the evolution loop is closed, and separate from what it measures", () => {
  // Evidence -> which step is not working -> change one thing -> re-verify -> next round
  // says. Two of those had tools already: tool-report says which TOOL is refused,
  // flow-compare which FLOW costs more. Neither says "ops-select is where this stalls", and
  // that is the only form of the answer a skill can be edited from — so the loop was open
  // at exactly the step that names what to change.
  //
  // evolve-report attributes each refusal to the skill the agent had loaded when it
  // happened, BY TRACE: skill_view says which skill, and everything after it is done while
  // following that skill. Attribution by document name would be a guess, because a flow may
  // write the same document from more than one step.
  //
  // And it must stay separate from what it measures. zz-evolve is a platform skill under
  // skills/, not a stage in any flow's manifest — an evaluation whose subject runs it is one
  // that means nothing, and a flow that listed it would be doing exactly that.
  const bad = [];
  const tool = join(root, "packages/tools/src/testing/evolve-report.ts");
  if (!existsSync(tool)) {
    bad.push("evolve-report is missing — nothing says which STEP stalls");
  } else {
    const src = readFileSync(tool, "utf8");
    // The trace attribution, not a document-name heuristic.
    // The attribution EXPRESSION, not the words. Testing for the string "skill_view"
    // passed when the branch was renamed to `skill_view_disabled`, which still contains it —
    // found by trying to break this check, and the reason to try.
    // Attribution is a COLUMN now — the gateway decides which step a call belonged to at the
    // door and stores it, so the report reads `e.step` instead of replaying skill loads per
    // caller. The trace fallback stayed for rows written before that existed, and both legs
    // are required: without the column the report is guessing, and without the fallback the
    // history written before today becomes unreadable.
    if (!/const stamped = e\.step/.test(src) || !/following\.set\(e\.caller/.test(src)) {
      bad.push("evolve-report no longer attributes refusals to the skill being followed");
    }
    if (!/refusalClass/.test(src)) {
      bad.push("evolve-report no longer groups refusals by class — raw texts do not rank");
    }
  }
  // WHERE THE LOOP CLOSES, now that no skill claims to close it.
  //
  // This required skills/zz-skill-evolve to exist. That skill named four steps and three of
  // them were `zz-tool` shell commands, which no agent on this platform can run — and the
  // fourth, changing a skill, is impossible at runtime because /catalog and /skills are
  // read-only wherever the platform runs. So it instructed an agent to do four things, three
  // of which no agent could do, and in two months it never ran once. Its two recorded runs
  // are the evaluation flow's own calls, mis-attributed to it because it was the last skill
  // loaded.
  //
  // The loop is real and it closes elsewhere: the report SPECIFIES the change and a release
  // APPLIES it. So what has to be true is that the report says so — one change, the expected
  // effect written down, and the route named. A recommendation that does not say what it
  // expects cannot be contradicted by the next round, and gets read as agreement whatever
  // that round says.
  const report = join(root, "catalog/zz/zz-skill-eval/skills/zz-skill-report/SKILL.md");
  if (!existsSync(report)) {
    bad.push("zz-skill-report is missing — nothing specifies the change the evidence calls for");
  } else {
    const r = readFileSync(report, "utf8");
    if (!/ONE CHANGE, AND SAY WHAT YOU EXPECT IT TO DO/.test(r)) {
      bad.push("zz-skill-report no longer requires one change with its expected effect — " +
               "two changes in a round make the next round unable to attribute either, and a " +
               "recommendation with no expectation cannot be contradicted");
    }
    if (!/release/i.test(r)) {
      bad.push("zz-skill-report no longer names how a change actually ships — the catalog is " +
               "read-only at runtime, so a recommendation that does not say 'repository and " +
               "release' dead-ends");
    }
  }
  // Never a stage of a flow, whatever it is called: that installs the change beside its own
  // measurement. Held against the retired name too, so restoring it as a stage still fails.
  for (const f of flows) {
    const m = JSON.parse(readFileSync(join(f.dir, "flow.json"), "utf8"));
    if ((m.stages ?? []).some((x) => x.name === "zz-skill-evolve")
        || (m.standalone ?? []).includes("zz-skill-evolve")) {
      bad.push(`${f.owner}/${f.flow} lists zz-skill-evolve — the measured must not run the measure`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

// PROVENANCE THAT NOTHING CAN READ ANSWERS NOTHING.
//
// The other half of the column rule. "A column the platform enforces is a column something
// can write" catches a guard with no writer; this catches a writer with no reader.
// `flow_install.installed_by` and `tool_grant.granted_by` were both written on every insert
// since the schema was created and appeared in no select anywhere — so "who gave this team
// casebox, and when" could only be answered by opening the database by hand, which is the same
// answer as not having recorded it. This platform's own principle is that provenance is
// produced mechanically; recording it where nobody can reach it is the form that looks like
// compliance.
//
// Only the `_by` columns. Every column has to be written; not every column is a claim about
// who did something, and a claim about who did something exists to be read back.
check("provenance the platform records is provenance something reads", () => {
  const src = sourceFiles(["services", "packages"], [".ts"])
    .map((f) => readFileSync(join(root, f), "utf8"));
  const bad = [];
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

// AN ALLOWLIST ENTRY NO TOOL CAN PRODUCE IS DEBRIS.
//
// IDENTIFIER_ARGS decides which argument values the platform keeps. Two of its entries could
// never appear: `open_only` is named by nothing anywhere in this repository, and `kr` exists
// only nested inside okr_grade's `scores`, which identifiers() never sees because it reads
// the TOP-LEVEL arguments. An entry that cannot be reached reads as a considered decision
// and is only debris — and this list is where the reasoning about what may be recorded
// lives, so debris in it is worse than debris elsewhere.
//
// The other direction is deliberately not checked. An argument absent from the list is
// absent on purpose, and most of them are content: a query, a body, a title, an api_key.
check("every identifier the telemetry keeps is one a tool can send", () => {
  const src = readFileSync(join(root, "services/gateway/src/tool-telemetry.ts"), "utf8");
  const region = between(src, "const IDENTIFIER_ARGS = new Set([", "]);");
  if (!region.text) return `IDENTIFIER_ARGS cannot be located: ${region.why}`;
  // EVERY quoted name, not the first on each line. The line-anchored version missed a second
  // entry written beside another — the same blind spot as reading a one-line inputSchema,
  // found the same way: by putting the defect back and watching the check not notice.
  const listed = [...region.text.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  if (listed.length === 0) return "IDENTIFIER_ARGS is empty — the extraction is broken";

  // The TOP-LEVEL argument names every tool declares, which is what identifiers() iterates.
  const declared = new Set();
  for (const f of sourceFiles(["services"], [".ts"])) {
    const text = readFileSync(join(root, f), "utf8");
    for (const t of toolsIn(text)) {
      const schema = between(t.body, "inputSchema:", "async (");
      if (!schema.text) continue;
      // TOP LEVEL ONLY, by removing nested objects rather than by counting indentation.
      // Anchoring to a line start looked equivalent and was not: knowledge_supersede writes
      // its whole schema on one line, so both of its arguments vanished and `old_id` came
      // back as an entry no tool declares. A check that reports a defect because it cannot
      // read a formatting variant is the same failure as one that misses a defect.
      let flat = schema.text;
      for (let i = 0; i < 5; i++) {
        const next = flat.replace(/z\.object\(\{[^{}]*\}\)/g, "z.nested()");
        if (next === flat) break;
        flat = next;
      }
      for (const m of flat.matchAll(/([a-z_]+)\s*:\s*z\./g)) declared.add(m[1]);
    }
  }
  if (declared.size === 0) return "no tool arguments found — the extraction is broken";
  const bad = listed.filter((a) => !declared.has(a))
    .map((a) => `IDENTIFIER_ARGS keeps \`${a}\`, which no tool declares as a top-level argument`);
  return bad.join("\n");
});

check("telemetry keeps identifiers and never the team's own words", () => {
  // The rule is IDENTIFIER versus CONTENT, not name versus value. A skill name, an
  // initiative, a flow, a block, a path — the platform publishes those, and they identify
  // things rather than say anything. A title, a body, a query, an email, a key are the
  // team's own words about their own work, and they stay out of a table people read.
  //
  // The list has been wrong once already, in the way that matters: `confirm` sat in it
  // looking like an enum, and deactivate_person defines confirm as an ECHO OF THE EMAIL —
  // so the one value the list most deliberately excludes arrived under a safe-looking name.
  // Nothing stopped that but somebody noticing.
  //
  // A denylist of names that are content BY DEFINITION, whatever a tool calls them. This is
  // the half that can be stated without guessing; the identifier half stays a judgement.
  const src = readFileSync(join(root, "services/gateway/src/tool-telemetry.ts"), "utf8");
  const block = /const IDENTIFIER_ARGS = new Set\(\[([\s\S]*?)\]\)/.exec(src)?.[1];
  if (!block) return "IDENTIFIER_ARGS is no longer where this can read it";
  // Comments in the block explain what was REMOVED; only live entries count.
  const live = block.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const kept = new Set([...live.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
  const CONTENT = ["content", "body", "text", "title", "query", "q", "api_key", "key",
                   "secret", "token", "email", "user_email", "stakeholder", "note",
                   "reason", "criterion", "message", "description", "confirm",
                   "source_content", "source_title", "no_signoff_reason", "fields",
                   "accepted_by", "approved_by", "label", "name_display"];
  const bad = CONTENT.filter((c) => kept.has(c));
  return bad.length
    ? `${bad.join(", ")} in IDENTIFIER_ARGS — these are the team's own words, and this ` +
      "table is read by people and by tooling"
    : null;
});

check("a record that is counted is a record that is written once", () => {
  // The ledger row is appended at the close and skipped if one is already there. The
  // DOCUMENT had no such guard, so a second close overwrote its outcome while the ledger
  // kept the first — and the ledger is what OKR grading and flow-compare COUNT. "How many
  // were accepted this quarter" and what the closing document says would disagree, silently,
  // and the disagreement is invisible from either side.
  //
  // Both halves have to hold: the ledger appends once, and the close refuses a second one.
  // Either alone is the divergence.
  const src = zzCoreSource();
  const bad = [];
  if (!/already closed once/.test(src)) {
    bad.push("ledgerOnClose no longer skips a second row — a reclose would count twice");
  }
  // The refusal, in close() itself: read the outcome already on the document and stop.
  // From the one parser: `src.indexOf('\n    "close",')` found the newline registration form
  // only, and reformatting close() would have sliced from -1 — the last character of the
  // file — leaving an empty body and two failures about a rule nobody had touched.
  const body = zzCoreTools().find((t) => t.name === "close")?.body;
  if (!body) return "close() is not registered — this check cannot find what it is about";
  if (!/const already = parseEnvelope\(doc\)\.outcome/.test(body) || !/is already closed as/.test(body)) {
    bad.push("close() does not refuse an initiative that already carries an outcome");
  }
  return bad.length ? bad.join("; ") : null;
});

// The smoke suite has two failing verdicts and they mean opposite things: exit 1 is a finding
// about the FLOW, exit 2 is the DEPLOYMENT not answering. TurnBlocked is the whole difference,
// and a plain Error thrown where the environment gave up reports a rate limit as a regression
// — which sends the next reader to audit a flow that did nothing wrong.
//
// The general rule, rather than a list of the three places: RETRYING WITH BACKOFF IS ITSELF
// THE CLAIM THAT THE CONDITION IS TRANSIENT. Nobody sleeps between attempts at something they
// believe is a logic error. So a throw that follows a backoff loop is, by the code's own
// construction, the environment — and must say so. `send` waited through four attempts to open
// a generation and then threw a plain Error, so a front end too busy to start a stream failed
// the scenario.
check("a report counting an activity counts the ones that happened", () => {
  const bad = [];
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
  // zz.event.team_slug existed, was indexed, and was written by nothing on the busiest kind
  // of row there is: 2,610 tool_call events on the production store, every one null. Two of
  // the three reports that close the improvement loop depend on it — flow-compare joins an
  // event to an initiative by (team, initiative) and counts a row without one as
  // UNATTRIBUTED, and watch-results builds "a team has gone quiet" from the distinct teams in
  // the window. Both ran, both reported nothing, and nothing was wrong as far as either could
  // tell: an absent team reads exactly like a quiet platform.
  //
  // The shape is write-only-column, and this repository has now found it three times
  // (zz.decision derived and read by nothing; `ids` captured and read by nothing; this). The
  // rule it earns: a reader may not depend on a column no writer sets.
  //
  // THAT RULE, not the one instance. This named `teamSlug`, `tool-telemetry.ts` and two
  // reader files by hand, so it could only ever catch the case already fixed — the shape this
  // file criticises elsewhere as "a probe narrower than the code it guards finds the instance
  // you already knew about". Seven of thirteen logEvent call sites write no team, and they are
  // RIGHT to: a self-issued PAT and a package download belong to a person, not a team. So the
  // invariant is not "every writer attributes" but the one the paragraph above actually
  // states — a reader of team_slug must be reading kinds that something attributes.
  const bad = [];
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
    // Raw SQL writers too — collect-turns inserts `turn` rows through psql and never touches
    // logEvent, so a check reading only the helper would call that kind unwritten.
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

  // READERS. The SQL is assembled from adjacent string literals, so the seam is removed first
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
  // Two shipped skills stated a live count in the present tense — "of the eleven nodes on this
  // deployment, three carry a sentence of prose where a folder belongs" and "eight of the
  // eleven nodes on this deployment cannot be". Production has fourteen. Both sentences exist
  // to justify a rule and the reasoning is sound; what rots is the tense. This repository
  // already draws that line for STATE.md and docs/release — a fact and a status are different
  // things — and nothing drew it for a skill a tenant reads.
  //
  // WHITESPACE IS NORMALISED, and that is the whole reason this is a check rather than a grep.
  // A third instance sits in ops-intent as "...an initiative on this\ndeployment...", wrapped
  // across two lines, so `grep "this deployment"` reports zero matches on a file that contains
  // it. A line-oriented sweep would have found two of the three and reported the file clean.
  //
  // A COUNT, not any mention. "there is an initiative on this deployment in that state" is an
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
  // R6 of the building-block contract — "validation errors in prose that teach the rule — no
  // silent coercion, no bare status codes" — is asked in two places: block-conformance asks
  // whether a block CAN teach, tool-report asks whether it DID. Both had their own answer and
  // the two disagreed on the message that motivated the requirement.
  //
  // block-conformance used a length floor of forty characters and a pattern that did not know
  // about `request failed with status code`. So "RPC ERROR: request failed with status code
  // 422" — forty-six characters, quoted in that file's own comment as the thing R6 exists to
  // catch — scored R6 as MET. It is also the commonest shape that engine sees, because
  // `RPC ERROR: ` is the prefix it adds to every JSON-RPC error itself.
  //
  // RUN, over the messages that separate the two readings. A rule with one implementation can
  // still be the wrong rule; what this holds is that there is one, and that it answers the
  // cases the requirement was written for.
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
    return `teachesTheRule could not be evaluated: ${String(err.message ?? err)}`;
  }

  const bad = [];
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
  // "The gateway captures it specifically so 'which skills does a winning run load that a
  // stalling one does not' can be answered, and that question stayed unanswerable because no
  // reader existed." This file said that twice, about `ids` and about `bytes` — a capture
  // wired at one end and nowhere at the other.
  //
  // The mirror of it is a field written on every row and read by nobody, and there was one:
  // `status`. tool-telemetry's own first paragraph explains that the telemetry it replaced had
  // `{"status": 200}` for its whole detail and could not answer the only question worth
  // asking, and then it wrote that field on every call.
  //
  // BOTH SIDES, because each is the other's failure: a field with no reader is capture nobody
  // asked for, and a reader with no field is a question that looks answered.
  //
  // The measurement fields now live in two places — real COLUMNS for what anybody groups by,
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
  const norm = (k) => k.toLowerCase().replace(/_/g, "");

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
  // WITHOUT COMMENTS. The prose in this block explains why each field is there, and a word
  // followed by a colon in a sentence reads exactly like a key — `column:` and `values:` were
  // both picked up as fields the telemetry writes.
  // SHORTHAND COUNTS. `ms,` and `bytes,` are properties as much as `caller: callerHash` is, and
  // `{ ids }` inside a conditional spread is one too — a pattern that reads only `name:` saw
  // three fields as unwritten while the reader correctly declared them, which is the check
  // accusing the code of the check's own blind spot.
  const written = new Set([...bag.text.matchAll(/(?:^|[{\s])([a-z_]+)\s*(?::|,|\s*\})/gm)]
    .map((m) => norm(m[1])).filter((k) => !PLUMBING.has(k)));
  for (const c of columns) written.add(c);

  // The reader: its interface, columns and bag alike.
  const iface = between(withoutComments(report), "interface CallRow {", "\n}\n");
  if (!iface.text) return "tool-report no longer declares the call row it reads";
  const declared = new Set([...iface.text.matchAll(/^\s+([a-z_]+)\??:/gm)]
    .map((m) => norm(m[1])).filter((k) => !PLUMBING.has(k)));
  if (!declared.size) return "tool-report declares no fields — the shape moved";

  const bad = [];
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

check("the platform records its own surface, the way it records everybody else's", () => {
  // WE ARE A BLOCK TOO, and for a long time the only one that could not be measured.
  //
  // `zz.block` has held a row for us since migration 024, which said why: our MCP "is not a
  // block in the zz-blocks sense and never will be — but it IS an MCP surface like any other".
  // What nothing did was record a VERSION, so `eval_block_surface('platform')` answered "no
  // recorded surface" and the one instrument this platform has for judging a tool surface
  // could be pointed at everyone except its author.
  //
  // Every other block is measured by probing it, because its surface is somebody else's to
  // declare. Ours is declared by the registerTool calls themselves — so the recording hangs
  // off those, and what we store cannot drift from what we serve. A second list built by hand
  // would be a claim about the surface; this is the surface.
  //
  // The check is that the wiring survives, because its failure is silent: nothing breaks, no
  // call refuses, and the only symptom is that a version leaves no row and "what moved since
  // the last release" quietly answers nothing.
  const src = zzCoreSource();
  const bad = [];
  if (!/OWN_TOOLS\.add\(name\)/.test(src)) {
    bad.push("registerTool no longer records the name it is registering — the surface would be recorded from something other than what is served, or not at all");
  }
  if (!/insert into zz\.block_version[\s\S]{0,200}where b\.name = 'platform'/.test(src)) {
    bad.push("nothing writes a zz.block_version row for 'platform' — eval_block_surface('platform') has nothing to read");
  }
  // Per version, and never rewritten: the row means "this is what that version served".
  if (!/on conflict \(block_id, version\) do nothing/.test(src)) {
    bad.push("the surface row is not per-version-and-once — rewriting it makes the history agree with today by construction, which is the one thing a history must not do");
  }
  // Recorded at boot, AFTER a server has been built: the doors are stateless, so nothing has
  // run buildServer by then and the set of names would be empty.
  const boot = src.slice(src.indexOf("app.listen(8000"));
  if (!/buildServer\(\);\s*await recordOwnSurface\(\)/.test(boot)) {
    bad.push("boot does not build a server before recording the surface — the doors are stateless, so nothing else has, and the recorded surface would be empty");
  }
  return bad.length ? bad.join("; ") : null;
});

check("every header the telemetry correlates on is actually sent", () => {
  // `x-zz-client` was READ in step-trace.ts and WRITTEN nowhere, so the second half of the
  // caller key was the empty string for every caller and the key was one half. Every process
  // acting as one person then shared a single skill trace — the onboarding timer, the
  // provisioner, zz-tool and that person's own chat session, all mutating it.
  //
  // Measured on UAT during a live round: 160 `render_agent_definition` rows from the
  // 60-second timer were attributed to `ops-build 1.2` and 35 to `zz-knowledge 2.0`, and one
  // write_file came out carrying one skill's name beside another skill's version. Those rows
  // are what tool-report, evolve-report and step-score count.
  //
  // A header read but never set is invisible: nothing errors, the key still has two halves,
  // and the numbers stay plausible. So the rule is checked rather than remembered.
  const src = [
    "services/gateway/src/step-trace.ts",
    "packages/mcp-client/src/index.ts",
  ].map((f) => readFileSync(join(root, f), "utf8"));
  const bad = [];
  const read = /headers\["x-zz-client"\]/.test(src[0]);
  const sent = /"x-zz-client":/.test(src[1]);
  if (read && !sent) {
    bad.push("step-trace correlates on x-zz-client and mcp-client never sends it — the caller key collapses to the email, so every process acting as one person shares one trace");
  }
  return bad.length ? bad.join("; ") : null;
});

check("a step's version comes from the skill, never from a file beside it", () => {
  // FOUND IN THE TELEMETRY OF A LIVE ROUND. `skill_view(name, file: "references/…")` serves a
  // supporting file, and the version was read out of whatever came back — so reading a
  // reference inside the skill you are following blanked step_version for every call after it
  // (seven casebox calls in one round), and reading a document TEMPLATE wrote the DOCUMENT's
  // version under the skill's name. runs.ts joins step_version against zz.skill_version, so a
  // blank matches nothing and those calls leave the per-version reports entirely — the numbers
  // still look plausible, which is why nobody noticed.
  const trace = readFileSync(join(root, "services/gateway/src/step-trace.ts"), "utf8");
  const tel = readFileSync(join(root, "services/gateway/src/tool-telemetry.ts"), "utf8");
  const bad = [];
  if (!/function stepLoaded\([^)]*whole\s*:\s*boolean/s.test(trace)) {
    bad.push("stepLoaded does not take whether the SKILL ITSELF was served — it cannot tell a skill from a file beside it");
  }
  // The version and the hash both, because either one taken from a supporting file is a claim
  // about the skill that the skill never made.
  if (!/stepVersion:\s*whole\s*\?/.test(trace)) {
    bad.push("stepVersion is not conditioned on the whole skill having been served");
  }
  if (!/stepSha:\s*whole\s*\?/.test(trace)) {
    bad.push("stepSha is taken from a supporting file's bytes — the hash then names a version of the skill that does not exist");
  }
  if (!/\bfile\b[^\n]*undefined/.test(tel) || !/loading\[0\]\.whole/.test(tel)) {
    bad.push("tool-telemetry does not read skill_view's `file` argument, so every supporting file is still recorded as a skill load");
  }
  return bad.length ? bad.join("; ") : null;
});
