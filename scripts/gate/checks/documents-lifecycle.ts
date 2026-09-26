/**
 * Approve, close, revise, show — the acts that move a document through its life, and the record
 * each leaves. An act that happens without its entry is indistinguishable, afterwards, from one
 * that never happened.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { between, contractsSource, functionBody, gatewaySource, root, sourceFiles, zzCoreSource, withoutComments } from "../read.ts";
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

check("document_revise records the material behind every version", () => {
  // Anchored on the logActivity payload, not on a word: searching forward from
  // src.indexOf("explained") lands inside "unexplained" in a comment, outside the window.
  //
  // `self_edit` must be absent and both remaining routes present: `sources` for material already
  // on the record, `source_content` for words that are not yet. A content change names its
  // material, whatever the edit was.
  const src = zzCoreSource();
  const bad: string[] = [];
  // The field, not the word: the handler explains in a comment why the route was removed, and a
  // check that cannot tell an explanation from a declaration fails on its own documentation.
  if (/self_edit:\s*z\./.test(src)) bad.push("self_edit is back; a content change names its material");
  if (!/sources:\s*z\.array/.test(src)) bad.push("document_revise no longer takes `sources` — nothing can cite an audit round");
  if (!/source_content:\s*z\.string\(\)/.test(src)) bad.push("document_revise no longer takes `source_content` — a cause with no file has nowhere to go");
  if (!/ERROR: nothing says what caused this version/.test(src)) bad.push("no refusal for a revision that cites nothing");
  // And the one it cannot invent: a source that already supports this document, newer than the
  // version being replaced, must be cited rather than ignored.
  if (!/supports/.test(src) || !/what this revision answers/.test(src)) {
    bad.push("nothing requires a revision to cite the sources that already support the document");
  }
  // The `sources` it suggests is the whole list, the call's own included: suggesting only the
  // missing one read as a replacement and sent a caller round between two sources (bug 5913fa5b).
  if (!/\[\.\.\.\(sources \?\? \[\]\)\.map\(\(x\) => x\.trim\(\)\), \.\.\.owed\]/.test(src)) {
    bad.push("the uncited-source refusal suggests only the missing sources, not the whole list to send");
  }
  const at = src.indexOf('action: "document_revise"');
  if (at < 0) { bad.push("the document_revise activity payload was not found"); }
  else {
    const payload = withoutComments(src.slice(Math.max(0, at - 600), at + 600));
    if (!/\bexplained\b/.test(payload) || !/\bsources\b/.test(payload)) {
      bad.push("the document_revise activity payload does not carry both `explained` and `sources`, so the record cannot say what a version rests on");
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

check("the store audit applies the platform's close rules, not stricter ones", () => {
  // COUPLED: manifest-audit must not carry a second copy of a rule the platform enforces, or it
  // reports defects nobody has and misses the ones they do.
  //
  // closeCheck exempts every gate but the closing document's own when the outcome is a stop: an
  // initiative that was dropped is precisely one whose gates were never passed. It also
  // separates existence from approval — a gated document that was never written is
  // requiredForClose's business, not the gate's.
  //
  // Run, because this is about what the function concludes. The filesystem is injected, so the
  // fixture is a set of documents rather than a directory.
  const src = readFileSync(join(root, "packages/tools/src/testing/manifest-audit.ts"), "utf8");
  // `as readonly string[]` is this body's own TypeScript, stripped here rather than in
  // functionBody: the shared lifter drops the annotations every lifted body has.
  const body = functionBody(src, "auditInitiative")?.replace(/\s+as\s+readonly\s+string\[\]/g, "");
  if (!body) return "manifest-audit no longer defines auditInitiative — this check cannot run";

  const contracts = contractsSource();
  const stopped = /OUTCOME_STOPPED[^=]*=\s*"([a-z]+)"/.exec(contracts)?.[1];
  if (!stopped) return "OUTCOME_STOPPED cannot be read from @zz/contracts";

  // ops-flow's own shape: spec.md is the closing document AND carries a gate, intent.md and
  // plan.md are gates that are not, guide.md is required for close.
  const DOCS = [
    { name: "intent.md", gate: true },
    { name: "spec.md", gate: true, closing: true },
    { name: "selection.md" },
    { name: "plan.md", gate: true },
    { name: "guide.md", requiredForClose: true },
  ];
  const run = (files: Record<string, unknown>): { problems: string[] } => {
    const present = new Map(Object.entries(files));
    let audit;
    try {
      audit = new Function(
        "join", "existsSync", "readFileSync", "frontmatter", "OUTCOMES", "OUTCOME_STOPPED",
        "STATUSES", "folder", "docs", "closing", "team", body,
      );
    } catch (err) {
      throw new Error(`auditInitiative could not be evaluated: ${errMessage(err)}`);
    }
    return audit(
      (...parts: string[]) => parts.join("/"),
      (f: string) => present.has(f),
      () => "one line",                       // activity.jsonl, non-empty
      (f: string) => present.get(f) ?? {},
      ["delivered", "accepted", stopped],
      stopped,
      ["draft", "approved"],
      "", DOCS, "spec.md", "",
    );
  };

  const bad: string[] = [];
  const closingEnv = (o: string, more: Record<string, unknown> = {}) =>
    ({ status: "approved", approved_by: "Dana", approved_at: "2026-08-30",
       outcome: o, closed_by: "dana@example.com", ...more });

  // A correctly abandoned initiative: the closing gate approved, guide.md written, intent.md
  // left in draft and plan.md never written — both of which the platform permits.
  const dropped = run({
    "/activity.jsonl": {},
    "/intent.md": { status: "draft" },
    "/spec.md": closingEnv(stopped),
    "/guide.md": { status: "draft" },
  });
  for (const p of dropped.problems) {
    bad.push(`an initiative closed as ${stopped} the platform permits was reported: ${p}`);
  }

  // And the exemption must not become a hole. The same store closed as accepted has a real
  // defect the platform refuses, and the closing document's own gate holds either way.
  const accepted = run({
    "/activity.jsonl": {},
    "/intent.md": { status: "draft" },
    "/spec.md": closingEnv("accepted", { accepted_by: "Dana Reyes" }),
    "/guide.md": { status: "draft" },
  });
  if (!accepted.problems.some((p) => p.includes("intent.md"))) {
    bad.push("an unapproved gate on an ACCEPTED initiative was not reported — the stop " +
             "exemption has become a hole");
  }
  const stopWithOpenClosingGate = run({
    "/activity.jsonl": {},
    "/spec.md": { status: "draft", outcome: stopped, closed_by: "dana@example.com" },
    "/guide.md": { status: "draft" },
  });
  if (!stopWithOpenClosingGate.problems.some((p) => p.includes("spec.md"))) {
    bad.push("the closing document's own gate was not required on a stop, and the platform " +
             "applies that one before the exemption");
  }
  const stopMissingRequired = run({
    "/activity.jsonl": {},
    "/spec.md": closingEnv(stopped),
  });
  if (!stopMissingRequired.problems.some((p) => p.includes("guide.md"))) {
    bad.push("a missing requiredForClose document was not reported on a stop — closeCheck " +
             "requires those whatever the outcome");
  }
  return bad.length ? bad.join("; ") : null;
});

check("nothing can clear the field that says an initiative already closed", () => {
  // `outcome` is the whole record that an initiative closed. initiative_close() reads it off the
  // document to refuse a second close; ledgerOnClose reads it off the file on disk to refuse a
  // second row. Both guards are one field deep, so anything that removes the field reopens the
  // initiative and lets the close run again, and _ledger.md records the same work twice.
  //
  // document_revise clears the governance fields so the gate goes back to a person; `outcome`
  // must not be in that list. closeCheck fires only on content that has an outcome, so no guard
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
  // And `document_revise` itself has to refuse the case, or the rule above is satisfied by a tool
  // that writes the whole envelope back without the field.
  const rev = between(zzCoreSource(),
                      '"document_revise",', "server.registerTool(");
  const code = (rev.text ?? "").split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  if (!rev.text) {
    bad.push(`document_revise is no longer readable here: ${rev.why}`);
  } else if (!/env\.outcome\s*=\s*closedOutcome/.test(code)
             || !/const\s+closedOutcome\s*=\s*prevEnv\.outcome/.test(code)) {
    // Carried forward, not refused. Requiring `if (prevEnv.outcome)` defends the ledger by
    // making a closed report uncorrectable.
    //
    // The invariant is narrower: whatever a revision does to the prose, the field that says the
    // initiative closed comes out the other side unchanged. initiative_close() still refuses a
    // second close and ledgerOnClose still returns before appending, and the text can still be
    // fixed with the signed copy frozen in _versions/.
    bad.push("document_revise does not carry `outcome` forward from the previous envelope — " +
             "read it into `closedOutcome` before the rebuild and write it back onto `env`. " +
             "Leaving the field merely untouched is not the same guarantee: it is the field " +
             "initiative_close() and ledgerOnClose both read to know an initiative already closed, and " +
             "the next edit to this function inherits nothing from an accident");
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
  // document the flow does not declare is exempt from its rules, so `document_revise` must not
  // run that test and refuse — an undeclared document would be creatable and rewritable forever
  // by document_write and be the one document that can never record why it changed.
  //
  // Both halves: `document_approve` goes on refusing an undeclared document, because there is no
  // gate on it and so no verdict to record. A revision is not a gate.
  const src = readFileSync(join(root, "services/zz-core/src/tools/initiative-acts.ts"), "utf8");
  const bodyOf = (tool: string): string => {
    const at = src.indexOf(`"${tool}"`);
    if (at < 0) return "";
    const next = src.indexOf("\n  );", at);
    return next < 0 ? src.slice(at) : src.slice(at, next);
  };
  const revise = withoutComments(bodyOf("document_revise"));
  const approve = withoutComments(bodyOf("document_approve"));
  if (!revise || !approve) return "document_revise or document_approve is no longer registered here";
  if (/is not a document this flow declares/.test(revise)) {
    return "document_revise refuses a document the flow does not declare, so the one call that "
         + "records WHY a document changed is unavailable on exactly the documents no flow is "
         + "watching — while document_write creates and rewrites them freely";
  }
  if (!/is not a document this flow declares/.test(approve)) {
    return "document_approve no longer refuses an undeclared document — there is no gate on one, "
         + "so an approval recorded against it is a verdict on a gate that does not exist";
  }
  return null;
});
