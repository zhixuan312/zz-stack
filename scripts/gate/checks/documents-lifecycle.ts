/**
 * Approve, close, edit, show — the acts that move a document through its life, and the record
 * each leaves. An act that happens without its entry is indistinguishable, afterwards, from one
 * that never happened.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import { contractsSource, errMessage, functionBody, gatewaySource, ONE_LINE, root, sourceFiles, zzCoreSource,
         zzCoreTools, withoutComments } from "../read.ts";
import { check } from "../run.ts";

/** A function declared in `src`, compiled to JavaScript and returned as a factory taking `scope` —
 *  the names it reads from its module — or null when it is not there. Compiled rather than stripped
 *  by pattern: an annotation like `string | undefined` survives every pattern short of a parser. */
function liftFunction(src: string, name: string, scope: string[]): ((...deps: unknown[]) => unknown) | null {
  const file = ts.createSourceFile("lift.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const decl = file.statements.find((n): n is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (!decl) return null;
  const js = ts.transpileModule(decl.getText(file).replace(/^export\s+/, ""),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...scope, `${js}\nreturn ${name};`) as (...deps: unknown[]) => unknown;
}

check("document_edit records the material behind every version", () => {
  // Anchored on the recordAct payload, not on a word: searching forward from
  // src.indexOf("explained") lands inside "unexplained" in a comment, outside the window.
  //
  // `self_edit` must be absent and both routes present: `sources` for material already on the
  // record, `source_content` for words that are not yet. A change to an approved body names its
  // material, whatever the edit was — `checks/edit-cause.ts` executes that refusal; this reads that
  // its text is the fixed one and that the platform links what it already knows.
  //
  // Removed with `document_revise`: the refusal that sent a caller back to cite a source filed
  // since the version it replaced, and the rule that it suggest the whole `sources` list
  // (bug 5913fa5b). The platform now links an owed source itself, as a `platform` cause, so there
  // is no refusal left to word — what holds instead is that the link is made.
  const src = zzCoreSource();
  const bad: string[] = [];
  // The field, not the word: a comment explaining why the route was removed is not a declaration,
  // and a check that cannot tell the two apart fails on its own documentation.
  if (/self_edit:\s*z\./.test(src)) bad.push("self_edit is back; a content change names its material");
  const edit = zzCoreTools().find((t) => t.name === "document_edit")?.body ?? "";
  if (!edit) return "document_edit is not registered";
  if (!/sources:\s*z\.array/.test(edit)) bad.push("document_edit no longer takes `sources` — nothing can cite an audit round");
  if (!/source_content:\s*z\.string\(\)/.test(edit)) bad.push("document_edit no longer takes `source_content` — a cause with no file has nowhere to go");
  if (!/ERROR: CAUSE_REQUIRED — /.test(withoutComments(src))) bad.push("no refusal for a change to an approved body that cites nothing");
  // And the cause it cannot invent but must not drop: a source that declares it supports this
  // document, filed since the release and cited by no version of it yet, is linked by the
  // platform on the next body change.
  const owed = functionBody(src, "owedSources") ?? "";
  const plan = withoutComments(functionBody(src, "planEdit") ?? "");
  if (!/kind = 'supports'/.test(owed) || !/->>'supports'/.test(owed)) {
    bad.push("owedSources no longer reads what a source declares it supports, so the platform links nothing it owes");
  }
  if (!/if \(bodyChanged\) \{\s*for \(const owed of await owedSources\([^)]*\)\) \{[^}]*causes\.push\(owed\)/.test(plan)) {
    bad.push("planEdit no longer adds the sources a body change owes to its causes — an audit round " +
             "filed against the document would be answered by a version that does not name it");
  }
  const code = withoutComments(edit);
  const at = code.indexOf('action: "document_edit"');
  if (at < 0) { bad.push("the document_edit activity payload was not found"); }
  else {
    const payload = code.slice(Math.max(0, at - 600), at + 600);
    if (!/\bexplained\b/.test(payload) || !/\bsources\b/.test(payload)) {
      bad.push("the document_edit activity payload does not carry both `explained` and `sources`, so the record cannot say what a version rests on");
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("document_present returns a document, not a rendering or a summary", () => {
  // "Your reply includes the document's full content" lives only in zz-platform's prose, and
  // prose gets routed around. A tool can be checked.
  //
  // The body read is the whole registration, comments included, which is why the prose about
  // what this tool must not do sits above `server.registerTool(` in server.ts, not inside it.
  //
  // One line per refusal: every refusal in server.ts concatenates quoted literals with
  // backticked identifiers, so a class excluding the backtick stops at the first `"ERROR: "`.
  // The newline is the bound, so a fragment cannot run past its own source line.
  const src = zzCoreSource();
  const at = src.indexOf('registerTool(\n    "document_present"');
  if (at < 0) return "document_present is not registered";
  const body = withoutComments(src.slice(at, src.indexOf("\n  );", at)));
  const bad: string[] = [];
  if (/renderMarkdown|marked|<pre>|escapeHtml/.test(body)) {
    bad.push("document_present emits HTML; the interfaces render markdown");
  }
  if (!/ERROR:[^"'\n]*no document at/.test(body)) {
    bad.push("document_present does not refuse a missing path by name");
  }
  return bad.length ? bad.join("; ") : null;
});

check("an act and the act that undoes it are recorded the same way", () => {
  // auditAdmin takes an optional team, and the activity feed a team admin reads is scoped by it,
  // so both halves of a paired act must pass it — a token appearing for a team and never being
  // withdrawn is the half somebody checks after a leak. Paired by name rather than by a list, so
  // a new pair is covered the day it is written.
  const src = gatewaySource();
  // Every auditAdmin call, with the kind it records and whether a team argument follows the
  // detail object.
  const calls = new Map();
  for (const m of src.matchAll(/auditAdmin\(/g)) {
    // Walk to the matching close, counting arguments at depth 1. A regex cannot do this:
    // every call carries an object literal and several carry a nested call.
    let depth = 0, args = 1, i = m.index + m[0].length - 1, inStr = "";
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (inStr) { if (c === "\\") i += 1; else if (c === inStr) inStr = ""; continue; }
      if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
      if (c === "(" || c === "{" || c === "[") depth += 1;
      else if (c === ")" || c === "}" || c === "]") { depth -= 1; if (depth === 0) break; }
      else if (c === "," && depth === 1) args += 1;
    }
    const kind = /"([a-z_]+)"/.exec(src.slice(m.index, i))?.[1];
    // id, kind, subject, detail, team — a team is the fifth.
    if (kind) calls.set(kind, args >= 5);
  }
  if (calls.size < 4) return "auditAdmin calls are no longer where this can read them";
  const OPPOSITES = [["create", "archive"], ["add", "remove"], ["install", "uninstall"],
                     ["grant", "revoke"], ["issue", "revoke"]];
  const bad: string[] = [];
  for (const [kind, hasTeam] of calls) {
    for (const [a, b] of OPPOSITES) {
      if (!kind.startsWith(`${a}_`)) continue;
      const other = `${b}_${kind.slice(a.length + 1)}`;
      if (!calls.has(other)) continue;
      if (hasTeam !== calls.get(other)) {
        bad.push(`${kind} records a team and ${other} does not, or the reverse — the act and ` +
                 "the act that undoes it must be equally visible to the team that sees one");
      }
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("nothing can clear the field that says an initiative already closed", () => {
  // `outcome` is the whole record that an initiative closed. initiative_close() reads it off the
  // document to refuse a second close; ledgerOnClose reads it off the file on disk to refuse a
  // second row. Both guards are one field deep, so anything that removes the field reopens the
  // initiative and lets the close run again, and _ledger.md records the same work twice.
  //
  // document_edit takes the approval off a changed approved document so the gate goes back to a
  // person; `outcome` must not go with it. closeCheck fires only on content that has an outcome, so no guard
  // sees its removal.
  const bad: string[] = [];
  for (const rel of sourceFiles(["services", "packages"], [".ts"])) {
    const src = readFileSync(join(root, rel), "utf8");
    src.split("\n").forEach((ln, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;               // prose about it is the record
      if (!/delete\s+\w+\.outcome\b|\.outcome\s*=\s*(""|''|null|undefined)|putEnvelopeField\([^,]+,\s*"outcome",\s*""/.test(ln)) return;
      bad.push(`${rel}:${i + 1} clears \`outcome\` — \`${ln.trim().slice(0, 70)}\`. That is the ` +
               "field initiative_close() and ledgerOnClose both read to know an initiative already " +
               "closed, so removing it lets the same work be closed and counted twice");
    });
  }
  // And the change path itself has to carry the field, or the rule above is satisfied by a tool
  // that writes the whole envelope back without it. `document_edit` composes a candidate's
  // envelope in `envelopeOf`; it is compiled out of zz-core and RUN here over a closed record.
  //
  // Carried forward, not refused. Refusing a change to a closed document defends the ledger by
  // making a closed report uncorrectable. The invariant is narrower: whatever a correction does to
  // the prose, the fields that say the initiative closed and who closed it come out the other side
  // unchanged, while the approval comes off — the correction is a draft. initiative_close() still
  // refuses a second close and ledgerOnClose still returns before appending.
  const core = zzCoreSource();
  const plan = withoutComments(functionBody(core, "planEdit") ?? "");
  if (!/const env = envelopeOf\(loaded\.text, a, approved, gated\)/.test(plan)
      || !/renderEnvelope\(env,/.test(plan)) {
    bad.push("planEdit no longer composes the candidate's envelope from envelopeOf over the stored " +
             "envelope, so what this check runs is not what document_edit writes");
  }
  const block = /export const ENVELOPE_BLOCK = (\/.*\/)[a-z]*;/.exec(contractsSource());
  const parse = liftFunction(contractsSource(), "parseEnvelope", ["ENVELOPE_BLOCK"]);
  const envelopeOf = liftFunction(core, "envelopeOf", ["parseEnvelope", "oneLine"]);
  if (!block || !parse || !envelopeOf) {
    bad.push("envelopeOf, parseEnvelope or ENVELOPE_BLOCK can no longer be read — the carry of " +
             "`outcome` and `closed_by` on a correction is unchecked");
  } else {
    const parseEnvelope = parse(new Function(`return ${block[1]}`)());
    const compose = envelopeOf(parseEnvelope, ONE_LINE) as
      (current: string, a: Record<string, unknown>, approved: boolean, gated: boolean) => Record<string, string>;
    const closed = ["---", "flow: sdlc-flow", "type: review", "title: Review", "status: approved",
                    "approved_by: dana@example.com", "approved_at: 2026-10-01", "outcome: accepted",
                    "closed_by: dana@example.com", "---", "", "# Review", ""].join("\n");
    const cases: [string, Record<string, unknown>, boolean, boolean][] = [
      ["a gated closed document's body", {}, true, true],
      ["a gated closed document's title and fields", { title: "Review, corrected", fields: { due_date: "2026-11-01" } }, true, true],
      ["an ungated closed document", { tags: ["x"] }, true, false],
      ["a closed document not approved", { stakeholder: "Dana" }, false, false],
    ];
    for (const [what, args, approved, gated] of cases) {
      let env: Record<string, string>;
      try {
        env = compose(closed, args, approved, gated);
      } catch (err) {
        bad.push(`envelopeOf could not be run: ${errMessage(err)}`);
        break;
      }
      if (env.outcome !== "accepted" || env.closed_by !== "dana@example.com") {
        bad.push(`a correction of ${what} does not carry \`outcome\` and \`closed_by\` forward ` +
                 `(${JSON.stringify({ outcome: env.outcome, closed_by: env.closed_by })}) — they are the ` +
                 "fields initiative_close() and ledgerOnClose read to know an initiative already closed");
      }
      if (approved && (env.approved_by || env.approved_at || env.status === "approved")) {
        bad.push(`a correction of ${what} keeps its approval — a change is a draft until a person approves it again`);
      }
    }
  }
  return bad.join("\n");
});

check("the closing document is resolved from the list the flow declared", () => {
  // Anchored on the variable the bug depends on, which statement reordering cannot defeat. Not a
  // source-order test: the correct implementation writes closingDoc as an ES6 shorthand with no
  // trailing colon, and a buggy one that appends first and recomputes puts "handover.md" earlier
  // and passes.
  //
  // deriveChain is not exported and importing the module would bind port 8000 and open a
  // Postgres connection during a gate run, so a behavioural test is not available. A heuristic.
  const src = zzCoreSource();
  const at = src.indexOf("function deriveChain(");
  if (at < 0) return "deriveChain is gone or was renamed — every document list resolves through it";
  const body = withoutComments(src.slice(at, src.indexOf("\n}", at)));
  const bad: string[] = [];
  if (!/closingDoc:\s*list\.find\(/.test(body)) {
    bad.push("closingDoc is not computed from the untouched `list` parameter — reading an augmented array makes an appended handover.md the closing document for any flow that marks none");
  }
  if (/\blist\s*=[^=]/.test(body)) {
    bad.push("`list` is reassigned inside deriveChain — the appended array must live under a different identifier, or the closing fallback can see it");
  }
  return bad.length ? bad.join("; ") : null;
});

check("a document the flow does not declare can still record why it changed", () => {
  // The same test, the opposite action. `write-guards.ts` writes
  // `if (chain.documents.length && !chain.docs.has(parts[1])) return null;` at four guards: a
  // document the flow does not declare is exempt from its rules, so `document_edit` must not run
  // that test and refuse — an undeclared document would be creatable by document_write and then
  // be the one document that can never change, or never record why it changed.
  //
  // Both halves: `document_approve` goes on refusing an undeclared document, because there is no
  // gate on it and so no verdict to record. A change is not a gate.
  const src = readFileSync(join(root, "services/zz-core/src/tools/initiative-acts.ts"), "utf8");
  const bodyOf = (tool: string): string => {
    const at = src.indexOf(`"${tool}"`);
    if (at < 0) return "";
    const next = src.indexOf("\n  );", at);
    return next < 0 ? src.slice(at) : src.slice(at, next);
  };
  const approve = withoutComments(bodyOf("document_approve"));
  const edit = withoutComments(zzCoreTools().find((t) => t.name === "document_edit")?.body ?? "");
  const plan = withoutComments(functionBody(zzCoreSource(), "planEdit") ?? "");
  if (!edit || !plan || !approve) return "document_edit, its planEdit or document_approve is no longer readable here";
  if (/is not a document this flow declares|gateRefusal\(/.test(edit + plan)) {
    return "document_edit refuses a document the flow does not declare, so the one call that "
         + "changes a document and records WHY is unavailable on exactly the documents no flow is "
         + "watching — while document_write creates them freely";
  }
  // The refusal itself is `gateRefusal`'s (chain.ts), which the document panel asks too.
  const gate = withoutComments(readFileSync(join(root, "services/zz-core/src/chain.ts"), "utf8"));
  if (!/gateRefusal\(chain, parts\[1\]\)/.test(approve) || !/is not a document this flow declares/.test(gate)) {
    return "document_approve no longer refuses an undeclared document — there is no gate on one, "
         + "so an approval recorded against it is a verdict on a gate that does not exist";
  }
  return null;
});
