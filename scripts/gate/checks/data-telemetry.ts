/**
 * Telemetry: the write side. Every tool that mutates state records that it did; every
 * identifier the platform keeps is one a tool can actually send, and never the team's own
 * words; and the platform's own surface, its correlation headers and its per-call version are
 * recorded the same way everybody else's are.
 *
 * The read side — whether a report, a count or a reader actually depends on what got
 * written here — is checks/data-telemetry-reports.ts.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { between, root, sourceFiles, toolsIn, zzCoreSource, zzCoreTools } from "../read.ts";
import { check } from "../run.ts";
import { schemaColumns } from "../facts.ts";

check("a tool that changes something records that it did", () => {
  // Provenance is one of the platform's permanents, and principle 6 says evidence must be
  // produced mechanically. A mutation nobody recorded is a fact about the platform that can
  // only be recovered by reading the state it changed.
  //
  // credential_set and credential_delete were the gap, and the shape of it is what
  // makes it worth a check: their OPERATOR twins — credential_admin_set,
  // credential_admin_delete — both logged an event, so the same change to the same store was
  // recorded when an operator made it and invisible when the person made it themselves. The
  // audited path was the rare one; the unaudited path is how almost every key is stored. So
  // "who holds a key for casebox, and since when" could only be answered by opening a file that
  // holds those keys in plaintext.
  //
  // The key itself is never recorded, and that is not what this asks for: THAT a credential
  // changed is provenance, its value is not.
  const MUTATES = /\b(writeFileSync|appendFileSync|withCredentials\(|insert into|update zz\.|delete from)/i;
  const RECORDS = /\b(logActivity\(|auditAdmin\(|logEvent\(|platformEvent\(|commitStore\()/;
  const bad: string[] = [];
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
  // looking like an enum, and person_deactivate defines confirm as an ECHO OF THE EMAIL —
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
  const bad: string[] = [];
  if (!/already closed once/.test(src)) {
    bad.push("ledgerOnClose no longer skips a second row — a reclose would count twice");
  }
  // The refusal, in initiative_close() itself: read the outcome already on the document and stop.
  // From the one parser: `src.indexOf('\n    "initiative_close",')` found the newline registration form
  // only, and reformatting initiative_close() would have sliced from -1 — the last character of the
  // file — leaving an empty body and two failures about a rule nobody had touched.
  const body = zzCoreTools().find((t) => t.name === "initiative_close")?.body;
  if (!body) return "initiative_close() is not registered — this check cannot find what it is about";
  if (!/const already = parseEnvelope\(doc\)\.outcome/.test(body) || !/is already closed as/.test(body)) {
    bad.push("initiative_close() does not refuse an initiative that already carries an outcome");
  }
  return bad.length ? bad.join("; ") : null;
});

check("the platform records its own surface, the way it records everybody else's", () => {
  // WE ARE A BLOCK TOO, and for a long time the only one that could not be measured.
  //
  // `zz.block` has held a row for us since migration 024, which said why: our MCP "is not a
  // block in the zz-blocks sense and never will be — but it IS an MCP surface like any other".
  // What nothing did was record a VERSION, so a surface report about `platform` answered "no
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
  const bad: string[] = [];
  if (!/OWN_TOOLS\.set\(name, door\)/.test(src)) {
    bad.push("registerTool no longer records the name it is registering AND the door it is registering it on — the surface would be recorded from something other than what is served, or not at all");
  }
  // ATTACHED TO A VERSION SOMEBODY ELSE WROTE. register-plugins creates zz.plugin_version at
  // release, from the lock, with the digest that vouches for the content. Recording a surface
  // only ever attaches tools to a row that already exists — a version nobody released has no
  // surface to record, and creating the row here would put a version in the registry with
  // nothing standing behind it.
  if (!/select pv\.id::text as id from zz\.plugin_version pv/.test(src)) {
    bad.push("the surface is not attached to a released zz.plugin_version — either nothing is recorded, or this writes a version row that no release vouches for");
  }
  // PER PLUGIN, FROM THE DOOR. A door IS a plugin's declared server, so the door a tool
  // registered on says whose tool it is. Filed under one blanket row instead, the ten
  // evaluation tools — which arrive only with zz-plugin-eval — were recorded as the
  // platform's own.
  if (!/pluginForDoor\(door\)/.test(src)) {
    bad.push("the surface is not filed per plugin — every tool this process serves lands under one registry row, and the evaluation door's tools stop being the evaluation plugin's");
  }
  // THE DOOR IS IN THE ROW, AND IT IS IN THE SAME STATEMENT AS THE NAME. Migration 052 added
  // the door column for one reason: a surface recorded as names alone answered NO CHANGE when
  // ten tools moved from `/core/mcp` to `/eval/mcp`, because not one name changed. A writer
  // that goes back to (version, name) restores that wrong answer silently — every row still
  // appears, the column just stays null, and the reader correctly reports it as not comparable
  // rather than as a fault. So the write is what is checked here.
  if (!/insert into zz\.plugin_tool \(plugin_version_id, name, door\)/.test(src)) {
    bad.push("the surface row no longer carries the door it was served on — a surface recorded as names alone reports NO CHANGE when a tool moves between doors, which is the wrong answer this platform's largest surface change already got");
  }
  if (!/OWN_TOOLS\.get\(name\)/.test(src)) {
    bad.push("the door written into zz.plugin_tool does not come from OWN_TOOLS — it would be a second account of which door a tool is on, and the one in OWN_TOOLS is the one the registration itself created");
  }
  // Per version and per name, never rewritten: the row means "this is what that version served".
  if (!/on conflict \(plugin_version_id, name\) do nothing/.test(src)) {
    bad.push("the surface row is not per-version-and-once — rewriting it makes the history agree with today by construction, which is the one thing a history must not do");
  }
  // Recorded at boot, AFTER a server has been built: the doors are stateless, so nothing has
  // run a builder by then and the set of names would be empty.
  //
  // EVERY DOOR, AND THE LIST IS DERIVED FROM THE MOUNTS. This named `buildServer` when that was
  // the only factory there was. zz-core now serves two doors — `/mcp` and `/eval-mcp`, one
  // process, two tool sets — and building only the first would record a platform that serves
  // ten fewer tools than it does. That is worse than recording nothing: the surface report
  // diffs a version against the one before it, so the release that merely MOVED those tools
  // would report them deleted, and a diff that invents a finding is the one failure this
  // instrument cannot have. So the factories come out of the `serveMcp` calls themselves, and
  // a third door added tomorrow is covered by this check on the day it is mounted.
  // Everything boot runs BEFORE the record is written. A builder called after it has filled
  // nothing by the time the names are read, so "called at boot" is not the property — "called
  // first" is, and an empty slice here makes every clause below fire rather than pass.
  //
  // MEASURED FROM THE TOP OF THE FILE, not from `app.listen`. The builders used to sit inside
  // the listen callback and a window starting there saw them; they now run ABOVE `listen`,
  // because the issuance guard has to read the registrations they fill and a refusal has to be
  // able to stop the process coming up rather than throw at a bound socket. That is the same
  // property this clause is about — built before recorded — satisfied EARLIER, and a window
  // anchored at `listen` reported it as absent. Anchor on the record instead: it is the thing
  // everything here has to precede.
  // The CALL, not the declaration — `async function recordOwnSurface()` sits near the top of
  // the file, and anchoring on the bare name put the window before everything.
  const at = src.search(/(?:await|void)\s+recordOwnSurface\(\)/);
  const built = at < 0 ? "" : src.slice(0, at);
  const factories = [...src.matchAll(/serveMcp\(app,\s*"[^"]+",\s*(\w+)\)/g)].map((m) => m[1]);
  if (!factories.length) {
    bad.push("no serveMcp(app, \"path\", factory) call found in zz-core — this clause cannot see which doors exist, so it asserted nothing about what the recorded surface covers");
  }
  if (at < 0) {
    bad.push("boot never calls recordOwnSurface — nothing records the surface at all");
  }
  for (const factory of factories) {
    // A CALL, never the declaration. The window now starts at the top of the file so it can see
    // builders that run above `listen`, and `function buildServer(` lives up there too — so a
    // bare `${factory}(` matched the declaration and this clause passed for a builder nobody
    // called. That is the shape of defect this whole gate exists to refuse, introduced while
    // widening the window; the lookbehind is what makes the widened window honest.
    if (!new RegExp(`(?<!function\\s)\\b${factory}\\(`).test(built)) {
      bad.push(`boot does not build ${factory} before recording the surface — the doors are stateless, so nothing else has, and that door's tools would be missing from the surface we record`);
    }
    // AND IT BUILDS THE WHOLE SURFACE. A builder that cuts its tool list by the caller's role
    // registers the MEMBER surface at boot, where there is no caller — so a release that merely
    // gated a tool would be recorded as having deleted it. Matching `${factory}(` alone accepts
    // `${factory}(false)`, which is that bug spelled out; the flag has to be true where the
    // builder takes one.
    if (new RegExp(`\\b${factory}\\(\\s*false\\s*\\)`).test(built)) {
      bad.push(`boot builds ${factory} with its full-surface flag OFF — the surface recorded is the one a member sees, and a tool that was merely gated reads as deleted`);
    }
  }

  // ── AND THE COLUMN THE WRITE DEPENDS ON, WITH NO ROW CLAIMING A DOOR NOBODY RECORDED ───
  //
  // A writer naming a column no migration adds fails INSIDE the catch that makes recording
  // deliberately non-fatal: the service starts, one line says it could not record its surface,
  // and nothing is red. `schemaColumns()` replays every add and drop in order, so a later
  // migration removing the column is caught by the same clause.
  //
  // NOT NULL IS RIGHT HERE, and it was wrong on the table this replaces. `zz.block_tool` gained
  // `door` by migration 052, on a table that already held rows written before anything knew the
  // door — so a default or an `update … set door` there would have INVENTED the moves the first
  // diff showed, every `plugin_*` name claiming to have started on the core door. That is NO
  // CHANGE with the sign flipped, committed for good.
  //
  // `zz.plugin_tool` is a new table whose writer always knows the door, and 058 carries forward
  // only rows that already recorded one (`where bt.door is not null`). So the honest constraint
  // is NOT NULL: there is no row here whose door nobody knew, and a nullable column would let
  // one back in.
  const mig = "services/gateway/migrations/058_plugin_owns_its_surface.sql";
  const sql = (() => { try { return readFileSync(join(root, mig), "utf8"); } catch { return ""; } })();
  if (!schemaColumns().includes("plugin_tool.door")) {
    bad.push("no migration leaves zz.plugin_tool.door standing — the insert above names a column nothing creates, and it fails inside the catch that makes recording non-fatal, so the service starts and records nothing");
  }
  if (!sql) {
    bad.push(`${mig} could not be read, so nothing about which rows it carries forward was checked`);
  } else if (!/door\s+text not null/i.test(sql)) {
    bad.push(`${mig} leaves door nullable — a row whose door nobody recorded reads as a tool that moved from nowhere, which is the wrong answer this column exists to prevent`);
  } else if (!/where bt\.door is not null/i.test(sql)) {
    bad.push(`${mig} carries forward rows with no door — those are rows written before the door was recorded, and filing them under NOT NULL would make them claim one`);
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
  // document_write came out carrying one skill's name beside another skill's version. Those rows
  // are what tool-report, evolve-report and step-score count.
  //
  // A header read but never set is invisible: nothing errors, the key still has two halves,
  // and the numbers stay plausible. So the rule is checked rather than remembered.
  const src = [
    "services/gateway/src/step-trace.ts",
    "packages/mcp-client/src/index.ts",
  ].map((f) => readFileSync(join(root, f), "utf8"));
  const bad: string[] = [];
  const read = /headers\["x-zz-client"\]/.test(src[0]);
  const sent = /"x-zz-client":/.test(src[1]);
  if (read && !sent) {
    bad.push("step-trace correlates on x-zz-client and mcp-client never sends it — the caller key collapses to the email, so every process acting as one person shares one trace");
  }
  return bad.length ? bad.join("; ") : null;
});

check("a step's version comes from the skill, never from a file beside it", () => {
  // FOUND IN THE TELEMETRY OF A LIVE ROUND. `skill_read(name, file: "references/…")` serves a
  // supporting file, and the version was read out of whatever came back — so reading a
  // reference inside the skill you are following blanked step_version for every call after it
  // (seven casebox calls in one round), and reading a document TEMPLATE wrote the DOCUMENT's
  // version under the skill's name. runs.ts joins step_version against zz.skill_version, so a
  // blank matches nothing and those calls leave the per-version reports entirely — the numbers
  // still look plausible, which is why nobody noticed.
  const trace = readFileSync(join(root, "services/gateway/src/step-trace.ts"), "utf8");
  const tel = readFileSync(join(root, "services/gateway/src/tool-telemetry.ts"), "utf8");
  const bad: string[] = [];
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
    bad.push("tool-telemetry does not read skill_read's `file` argument, so every supporting file is still recorded as a skill load");
  }
  return bad.length ? bad.join("; ") : null;
});

check("an initiative that does not exist yet is not cached as an initiative with no flow", () => {
  // THE ASYMMETRY IS THE WHOLE CHECK. `flowFor` answers which flow an initiative runs, and
  // `tool-telemetry.ts` spends that answer on `owedBy` — which stage of the manifest owes the
  // document being written. A flow it HAS found cannot change: the platform decides `flow` at
  // `initiative_open` and offers no way to adopt one afterwards, so caching a hit is free.
  //
  // Caching a MISS is not. The miss is the answer for an initiative that does not exist yet,
  // and the next thing that happens is somebody creating it — so the cached absence outlives
  // the thing it described, and for the rest of the TTL every call is attributed as though the
  // initiative had no flow.
  //
  // AND THE FLOW'S OWN FIRST INSTRUCTION WALKS INTO IT. sdlc-flow opens with "ask the platform
  // where the initiative stands before anything else", so the opening sequence is a status
  // call on a slug that does not exist, then the open, then the first document — all inside
  // one TTL. Measured by driving exactly that on this deployment: status at 0s, explore.md
  // written at 29s with no step on its event, spec.md at 116s — past the TTL — carrying
  // `sdlc-spec`. Same caller, same initiative; the only difference was the clock.
  //
  // It never failed loudly because `stepName` falls back to the traced skill, so the row is
  // written and only the STAGE is missing — on precisely the calls that open a piece of work.
  const src = readFileSync(join(root, "services/gateway/src/step-trace.ts"), "utf8");
  const at = src.indexOf("export async function flowFor");
  if (at < 0) return "flowFor is gone, and with it the only thing that says which stage owes a document";
  const body = src.slice(at, src.indexOf("\n}", at));
  const sets = [...body.matchAll(/flowCache\.set\(/g)];
  if (!sets.length) return "flowFor no longer caches at all — which is safe, but this check was written about a cache and should be rewritten rather than left passing on its absence";
  if (!/if \(flow\) flowCache\.set\(/.test(body)) {
    return "flowFor caches its lookup unconditionally, so an initiative that did not exist when "
         + "it was first asked about reads as a flowless initiative for the whole TTL — which is "
         + "the window in which it is created and its first document written";
  }
  return null;
});

check("the telemetry and the control loop name the same stage for the same act", () => {
  // ONE ACT MUST NOT HAVE TWO STEPS, and it had. The two sides of this platform each derive
  // "which stage does this complete" from the flow's manifest, and they read DIFFERENT fields
  // to do it: the telemetry reads `documents[].stage`, the evidence side reads which stage
  // `produces` that document. Two spellings of one answer, and nothing compared them.
  //
  // Measured while driving sdlc-flow end to end: a spec-audit round recorded through
  // `source_add` was filed by `zz.event` as `zz-platform` — the skill the agent happened to
  // have read last — and by `zz.control_evidence` as `sdlc-spec-audit`. An approval was filed
  // the same two ways. Neither table says the other exists, so neither could disagree out loud.
  //
  // THE SUBJECT IS EVERY REGISTERED FLOW, not a fixture, because a fixture agrees with itself.
  const probe = `
    import { stageOwing } from ${JSON.stringify(join(root, "services/gateway/dist/call-attribution.js"))};
    import { stepForDocument, stepForSource } from ${JSON.stringify(join(root, "services/zz-core/dist/host/enrolment.js"))};
    import { governingFlows, catalogManifest } from ${JSON.stringify(join(root, "packages/catalog/dist/index.js"))};
    const bad = [];
    for (const flow of governingFlows(true)) {
      const m = catalogManifest(flow, true);
      if (!m?.documents?.length) continue;
      for (const d of m.documents) {
        // The document side: telemetry from documents[].stage, evidence from stages[].produces.
        const viaTelemetry = stageOwing(flow, "document_write", { path: "2026-01-01-x/" + d.name });
        const viaEvidence = stepForDocument(m.stages ?? [], "2026-01-01-x/" + d.name);
        if (viaTelemetry !== viaEvidence) {
          bad.push(flow + "/" + d.name + ": telemetry says " + viaTelemetry + ", the control loop says " + viaEvidence);
        }
        // An approval completes the same stage as the write it approves.
        const approval = stageOwing(flow, "document_approve", { path: "2026-01-01-x/" + d.name });
        if (approval !== viaEvidence) {
          bad.push(flow + "/" + d.name + ": an approval is filed under " + approval + " while the document is " + viaEvidence);
        }
      }
      for (const st of (m.stages ?? []).filter((s) => s.produces === "source" && s.supports)) {
        const viaTelemetry = stageOwing(flow, "source_add", { supports: [st.supports] });
        const viaEvidence = stepForSource(m.stages ?? [], st.supports);
        if (viaTelemetry !== viaEvidence) {
          bad.push(flow + " source supporting " + st.supports + ": telemetry says " + viaTelemetry + ", the control loop says " + viaEvidence);
        }
        if (!viaTelemetry) {
          bad.push(flow + " source supporting " + st.supports + " is attributed to no stage at all, so the round falls back to whichever skill was read last");
        }
      }
    }
    console.log(JSON.stringify(bad));
  `;
  let out: string;
  try {
    out = execFileSync(process.execPath, ["--input-type=module", "-e", probe],
      { encoding: "utf8", env: { ...process.env, ZZ_CATALOG_DIR: join(root, "catalog") } });
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    return `the attribution probe could not run, so this agreement is unchecked: ${String(e.stderr ?? e.message ?? err).slice(0, 300)}`;
  }
  const bad = JSON.parse(out.trim()) as string[];
  if (bad.length) return bad.join("; ");
  return null;
});

check("the answer that names an initiative is actually captured, and an error names nothing", () => {
  // A FIX THAT COULD NEVER RUN. `initiative_open` takes a `slug` and composes the name from the
  // platform's clock, so its ARGUMENTS never carry the initiative — which is why a block exists
  // to read it from the ANSWER, carrying a comment saying exactly that. It sat behind
  // `if (served !== null)`, and `served` was `loading.length ? "" : null`: the response body was
  // captured only on a request that also read a skill. `initiative_open` never does. The fix was
  // written, committed, and executed zero times.
  //
  // Measured before this check existed: 110 `initiative_open` events on the deployment, 20
  // carrying an initiative, 17 of those naming one that exists.
  //
  // AND THE ARGUMENT SCAN FILLED THE GAP WITH SOMETHING WORSE. `initiative_status` on a slug
  // nobody opened answers `{"error": "no such initiative"}` — not an MCP error, so the row is
  // recorded `ok` — and the scan took the slug from the arguments and kept it for the rest of
  // the conversation. 436 events across the store name an initiative that was never created.
  const tel = readFileSync(join(root, "services/gateway/src/tool-telemetry.ts"), "utf8");
  const attr = readFileSync(join(root, "services/gateway/src/call-attribution.ts"), "utf8");
  if (/let served = loading\.length \? "" : null;/.test(tel)) {
    return "the response body is captured only when a skill is loaded, so the block that reads "
         + "an initiative out of initiative_open's answer cannot run — which is the state it was "
         + "in for its whole life";
  }
  if (!/ANSWER_NAMES_INITIATIVE\.test/.test(tel)) {
    return "nothing decides whether this request's answer is one that names an initiative, so "
         + "either the capture is unconditional or it is back to skill loads only";
  }
  const from = /export function initiativeFrom[\s\S]{0,2000}?\n}/.exec(attr)?.[0] ?? "";
  if (!from) return "initiativeFrom is gone — nothing derives which initiative a call is about";
  if (!/answer\.error === undefined/.test(from)) {
    return "an answer carrying an error still names an initiative to the trace, and an "
         + "initiative_status on a slug nobody opened echoes that slug back — which is how 436 "
         + "events came to be filed against initiatives that were never created";
  }
  if (!/if \(ANSWER_NAMES_INITIATIVE\.test\(String\(c\.params\?\.name \?\? ""\)\)\) continue;/.test(from)) {
    return "the argument scan no longer skips the two calls whose answer is the authority, so a "
         + "refused status call teaches the trace a name again";
  }
  return null;
});
