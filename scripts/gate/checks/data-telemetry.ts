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

import { between, functionBody, root, sourceFiles, toolsIn, zzCoreSource, zzCoreTools, withoutComments} from "../read.ts";
import { check } from "../run.ts";
import { schemaColumns } from "../facts.ts";

check("a tool that changes something records that it did", () => {
  // A mutation nobody recorded is a fact about the platform recoverable only by reading the
  // state it changed.
  const MUTATES = /\b(writeFileSync|appendFileSync|insert into|update zz\.|delete from)/i;
  const RECORDS = /\b(logActivity\(|auditAdmin\(|logEvent\(|platformEvent\(|commitStore\()/;
  const bad: string[] = [];
  // Every file that registers a tool, found by asking which ones do rather than by listing
  // today's doors — the subject of this check is a tool nobody thought to look at.
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

// IDENTIFIER_ARGS decides which argument values the platform keeps. An entry no tool can
// produce as a top-level argument is debris in the list that states what may be recorded.
//
// DELIBERATE: the other direction is not checked. An argument absent from the list is absent
// on purpose — most of them are content: a query, a body, a title, an api_key.
check("every identifier the telemetry keeps is one a tool can send", () => {
  const src = readFileSync(join(root, "services/gateway/src/tool-telemetry.ts"), "utf8");
  const region = between(src, "const IDENTIFIER_ARGS = new Set([", "]);");
  if (!region.text) return `IDENTIFIER_ARGS cannot be located: ${region.why}`;
  // Every quoted name, not the first on each line: two entries can share a line.
  const listed = [...region.text.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  if (listed.length === 0) return "IDENTIFIER_ARGS is empty — the extraction is broken";

  // The top-level argument names every tool declares, which is what identifiers() iterates.
  const declared = new Set();
  for (const f of sourceFiles(["services"], [".ts"])) {
    const text = readFileSync(join(root, f), "utf8");
    for (const t of toolsIn(text)) {
      const schema = between(t.body, "inputSchema:", "async (");
      if (!schema.text) continue;
      // Top level only, by removing nested objects rather than by counting indentation: a
      // whole schema can be written on one line.
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
  // The rule is identifier versus content, not name versus value. A skill name, an
  // initiative, a flow, a path identify things the platform publishes. A title, a
  // body, a query, an email, a key are the team's own words and stay out of the table.
  //
  // CONTENT below is a denylist of names that are content whatever a tool calls them — the
  // half that can be stated without judgement. `confirm` is on it because person_deactivate
  // defines it as an echo of the email.
  const src = readFileSync(join(root, "services/gateway/src/tool-telemetry.ts"), "utf8");
  const block = /const IDENTIFIER_ARGS = new Set\(\[([\s\S]*?)\]\)/.exec(src)?.[1];
  if (!block) return "IDENTIFIER_ARGS is no longer where this can read it";
  // Comment lines inside the block name removed entries; only live entries count.
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
  // Both halves have to hold: the ledger appends once, and the close refuses a second one.
  // Either alone lets the ledger's count and the closing document's outcome diverge.
  const src = zzCoreSource();
  const bad: string[] = [];
  // The guard, matched on the behaviour and not on a comment that explains it.
  //
  // Sliced first, stripped second: `withoutComments` shortens what it replaces, so stripping
  // before slicing moves every offset the slice depends on.
  const ledger = withoutComments(functionBody(src, "ledgerOnClose") ?? "");
  if (!ledger) {
    bad.push("ledgerOnClose() is not a function this can read — the append-once guard cannot be checked");
  } else if (!/parseEnvelope\([a-z]+\)\.outcome\)\s*return/.test(ledger)) {
    bad.push("ledgerOnClose no longer returns early on a document that already carries an outcome — a reclose would count twice");
  }
  // The refusal, in initiative_close() itself: read the outcome already on the document and
  // stop. Located through zzCoreTools(), which is format-independent.
  const body = zzCoreTools().find((t) => t.name === "initiative_close")?.body;
  if (!body) return "initiative_close() is not registered — this check cannot find what it is about";
  if (!/const already = parseEnvelope\(doc\)\.outcome/.test(body) || !/is already closed as/.test(body)) {
    bad.push("initiative_close() does not refuse an initiative that already carries an outcome");
  }
  return bad.length ? bad.join("; ") : null;
});

check("the platform records its own surface, the way it records everybody else's", () => {
  // The platform's own surface is recorded from the registerTool calls themselves, not from a
  // hand-written list, so what is stored cannot drift from what is served.
  //
  // The wiring's failure is silent — nothing breaks, no call refuses, a version just leaves
  // no row — so it is checked here.
  const src = withoutComments(zzCoreSource());
  const bad: string[] = [];
  if (!/OWN_TOOLS\.set\(name, door\)/.test(src)) {
    bad.push("registerTool no longer records the name it is registering AND the door it is registering it on — the surface would be recorded from something other than what is served, or not at all");
  }
  // Attached to a version register-plugins already created at release. Recording a surface
  // only ever selects an existing row; creating one here would register a version with no
  // release standing behind it.
  if (!/select pv\.id::text as id from zz\.plugin_version pv/.test(src)) {
    bad.push("the surface is not attached to a released zz.plugin_version — either nothing is recorded, or this writes a version row that no release vouches for");
  }
  // Per plugin, from the door: a door is a plugin's declared server, so the door a tool
  // registered on says whose tool it is.
  if (!/pluginForDoor\(door\)/.test(src)) {
    bad.push("the surface is not filed per plugin — every tool this process serves lands under one registry row, and the evaluation door's tools stop being the evaluation plugin's");
  }
  // The door is in the row, in the same statement as the name. A surface recorded as names
  // alone reports no change when a tool moves between doors, and the reader cannot tell a
  // null column from a genuine match.
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
  // Every door's builder must run before the record is written: the doors are stateless, so
  // until a builder runs the set of names is empty and that door's tools would be missing.
  // The factory list is derived from the `serveMcp` mounts, so a door added tomorrow is
  // covered on the day it is mounted.
  //
  // The window is the file above the `recordOwnSurface()` call — not `app.listen`, which the
  // builders now run above, and not the bare name, which matches the declaration near the top
  // of the file. An empty slice makes every clause below fire rather than pass.
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
    // The lookbehind matches a call and never the declaration, which is inside the window.
    if (!new RegExp(`(?<!function\\s)\\b${factory}\\(`).test(built)) {
      bad.push(`boot does not build ${factory} before recording the surface — the doors are stateless, so nothing else has, and that door's tools would be missing from the surface we record`);
    }
    // And it builds the whole surface. A builder that cuts its tool list by the caller's role
    // records the member surface at boot, where there is no caller, so a tool that was merely
    // gated reads as deleted.
    if (new RegExp(`\\b${factory}\\(\\s*false\\s*\\)`).test(built)) {
      bad.push(`boot builds ${factory} with its full-surface flag OFF — the surface recorded is the one a member sees, and a tool that was merely gated reads as deleted`);
    }
  }

  // And the column the write depends on, with no row claiming a door nobody recorded.
  //
  // A writer naming a column no migration adds fails inside the catch that makes recording
  // non-fatal: the service starts and nothing is red. `schemaColumns()` replays every add and
  // drop in order, so a later migration removing the column fails the same clause.
  //
  // `zz.plugin_tool`'s writer always knows the door, so `door` is NOT NULL — a nullable
  // column would let back in a row whose door nobody recorded.
  const schema = "services/gateway/migrations/001_init.sql";
  const sql = (() => { try { return readFileSync(join(root, schema), "utf8"); } catch { return ""; } })();
  const door = /create table zz\.plugin_tool \(([\s\S]*?)\n\);/i.exec(sql)?.[1]
    ?.match(/^\s+door\s+([^\n]*?),?$/im)?.[1] ?? "";
  if (!schemaColumns().includes("plugin_tool.door")) {
    bad.push("no migration leaves zz.plugin_tool.door standing — the insert above names a column nothing creates, and it fails inside the catch that makes recording non-fatal, so the service starts and records nothing");
  } else if (!sql) {
    bad.push(`${schema} could not be read, so nothing about the door column's nullability was checked`);
  } else if (!/^text\b[^\n]*not null/i.test(door)) {
    bad.push(`${schema} leaves zz.plugin_tool.door nullable — a row whose door nobody recorded reads as a tool that moved from nowhere, which is the wrong answer this column exists to prevent`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("every header the telemetry correlates on is actually sent", () => {
  // The caller key is the email plus `x-zz-client`. A header read but never sent is
  // invisible — nothing errors, the key just collapses to its first half, and every process
  // acting as one person shares one skill trace.
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
  // `skill_read(name, file: "references/…")` serves a supporting file, not the skill. A
  // version taken from that file's bytes names a skill version that does not exist, and
  // runs.ts joins step_version against zz.skill_version, so the call leaves every per-version
  // report.
  const trace = withoutComments(readFileSync(join(root, "services/gateway/src/step-trace.ts"), "utf8"));
  const tel = withoutComments(readFileSync(join(root, "services/gateway/src/tool-telemetry.ts"), "utf8"));
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
  // The asymmetry is the whole check. A flow `flowFor` has found cannot change — the platform
  // decides `flow` at `initiative_open` and offers no way to adopt one afterwards — so
  // caching a hit is free. A miss is the answer for an initiative that does not exist yet,
  // and the next thing that happens is somebody creating it, so a cached miss outlives what
  // it described and every call for the rest of the TTL is attributed as flowless.
  //
  // It fails quietly: `stepName` falls back to the traced skill, so the row is written and
  // only the stage is missing.
  const src = readFileSync(join(root, "services/gateway/src/step-trace.ts"), "utf8");
  const at = src.indexOf("export async function flowFor");
  if (at < 0) return "flowFor is gone, and with it the only thing that says which stage owes a document";
  const body = withoutComments(src.slice(at, src.indexOf("\n}", at)));
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
  // Both sides derive which stage an act completes from the flow's manifest, reading
  // different fields: the telemetry reads `documents[].stage`, the evidence side reads which
  // stage `produces` that document. Neither table says the other exists, so they cannot
  // disagree out loud.
  //
  // The subject is every registered flow, not a fixture — a fixture agrees with itself.
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
  // `initiative_open` takes a `slug` and composes the name from the platform's clock, so its
  // arguments never carry the initiative and it has to be read from the answer — which means
  // the response body must be captured on requests that load no skill.
  //
  // The argument scan is the other half: `initiative_status` on a slug nobody opened answers
  // `{"error": "no such initiative"}`, which is not an MCP error, so the row is recorded `ok`
  // and the scan would teach the trace a name that was never created.
  const tel = withoutComments(readFileSync(join(root, "services/gateway/src/tool-telemetry.ts"), "utf8"));
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

check("an initiative is carried forward within a team, never across a switch between two", () => {
  // A slug is unique per `(team_id, slug)`, not globally, and the trace Map is keyed by
  // caller alone — so a slug named under one team can be stamped onto a call made under
  // another. `initiative_status` on another team's initiative succeeds and its answer teaches
  // the trace that slug, so a team switch is not the only way in.
  //
  // The clauses match the expression that decides, not the block around it: a `team`
  // declared in `currentStep` and never compared would pass anything looser.
  const trace = withoutComments(readFileSync(join(root, "services/gateway/src/step-trace.ts"), "utf8"));
  const tel = withoutComments(readFileSync(join(root, "services/gateway/src/tool-telemetry.ts"), "utf8"));
  const bad: string[] = [];
  if (!/initiative: t\.team === team \? t\.initiative : undefined/.test(trace)) {
    bad.push("currentStep returns the traced initiative without comparing the team it was named "
           + "under to the team asking, so a slug that means nothing in this team is written "
           + "onto its rows");
  }
  if (!/initiativeSeen\(caller, learned, team\)/.test(tel)) {
    bad.push("the writer learns an initiative without telling the trace which team named it, "
           + "so currentStep has nothing to compare and withholds nothing");
  }
  if (!/currentStep\(caller, team\)/.test(tel)) {
    bad.push("the writer asks currentStep for a trace without naming the team it is asking "
           + "for, so the comparison in currentStep is against undefined");
  }
  return bad.length ? bad.join("; ") : null;
});

check("a field that has held an empty string is written as absent, not as two spellings of nothing", () => {
  // `??` coalesces null and undefined and not `""`, which is how one column comes to hold two
  // spellings of the same absence, neither joinable to `zz.skill`.
  //
  // Both lines of defence are checked: the trace says absent by being undefined, and the
  // writer refuses an empty string at the one place every row is written. A second field that
  // grows the same habit is caught by neither unless it is added to the loop below.
  const trace = withoutComments(readFileSync(join(root, "services/gateway/src/step-trace.ts"), "utf8"));
  const ev = withoutComments(readFileSync(join(root, "services/gateway/src/events.ts"), "utf8"));
  const bad: string[] = [];
  if (/initiative: prior [^\n]*: "",/.test(trace)) {
    bad.push("step-trace writes initiative: \"\" into a fresh trace, so a skill_read before any "
           + "initiative is known lands an empty string in the column");
  }
  for (const f of ["initiative", "step"]) {
    if (!new RegExp(`e\\.${f} \\|\\| null`).test(ev)) {
      bad.push(`events.ts binds e.${f} with ?? rather than ||, so an empty string reaches the `
             + `column verbatim — ?? coalesces null and undefined and not ""`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});
