/**
 * Approve, close, revise, show — the acts that move a document through its life, and the
 * record each leaves.
 *
 * These are the calls whose whole purpose is the record. An act that happens without its
 * entry is indistinguishable, afterwards, from one that never happened.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { between, contractsSource, functionBody, gatewaySource, root, sourceFiles, zzCoreSource } from "../read.ts";
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

check("document_revise records whether a revision had an external cause", () => {
  // An earlier version of this check searched forward from src.indexOf("explained") — which
  // lands inside the word "unexplained" in a comment at :5124, 6,946 characters before the
  // logActivity payload at :5226 and outside its own 4,000-char window. It could not have
  // verified the thing it was written for. Anchored on the payload instead.
  //
  // The ERROR class matches the check above it and diverges from the plan's for the same
  // reason: the refusal reads "ERROR: `self_edit` says nothing external caused this
  // version", so a class excluding the backtick stops at the space-backtick and never
  // reaches the field name. Backticks pass; the newline is the bound.
  const src = zzCoreSource();
  const bad: string[] = [];
  if (!/self_edit:\s*z\.string\(\)/.test(src)) bad.push("self_edit is missing or is not a string (spec D6 forbids a boolean)");
  if (/self_edit:\s*z\.boolean\(\)/.test(src)) bad.push("self_edit is a boolean; D6 requires a declaration of what was edited");
  if (!/ERROR:[^"'\n]*self_edit/.test(src)) bad.push("no refusal for self_edit supplied together with a cause");
  const at = src.indexOf('action: "document_revise"');
  if (at < 0) { bad.push("the document_revise activity payload was not found"); }
  else {
    const payload = src.slice(Math.max(0, at - 600), at + 600);
    if (!/\bexplained\b/.test(payload) || !/\bself_edit\b/.test(payload)) {
      bad.push("the document_revise activity payload does not carry both `explained` and `self_edit`, so the three states are indistinguishable");
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("document_present returns a document, not a rendering or a summary", () => {
  // "Your reply includes the document's full content" lived only in zz-platform's prose and
  // was routed around — including by the agent writing the spec about routing around it,
  // twice in one session. A tool can be checked; prose cannot.
  //
  // THE BODY THIS READS IS THE WHOLE REGISTRATION, comments included. That is why the prose
  // about what this tool must NOT do sits above `server.registerTool(` in server.ts rather
  // than inside it: a comment naming the renderer within the registration would fail this
  // check against a correct implementation.
  //
  // ONE LINE PER REFUSAL, the same character class as the two checks above and for the same
  // reason. Every refusal in server.ts is a concatenation of quoted literals with backticked
  // identifiers, so a class excluding the backtick — which is what the plan specified —
  // extracts `"ERROR: "` and dies at the first one, failing on correct code. Backticks pass
  // and the NEWLINE is the bound, so a fragment cannot run past its own source line and
  // collect words out of the code below it.
  const src = zzCoreSource();
  const at = src.indexOf('registerTool(\n    "document_present"');
  if (at < 0) return "document_present is not registered";
  const body = src.slice(at, src.indexOf("\n  );", at));
  const bad: string[] = [];
  if (/renderMarkdown|marked|<pre>|escapeHtml/.test(body)) {
    bad.push("document_present emits HTML; the interfaces render markdown (spec D9)");
  }
  if (!/ERROR:[^"'\n]*no document at/.test(body)) {
    bad.push("document_present does not refuse a missing path by name");
  }
  return bad.length ? bad.join("; ") : null;
});

check("an act and the act that undoes it are recorded the same way", () => {
  // auditAdmin takes an optional team, and the activity feed a team admin reads is scoped by
  // it. pat_issue passed the bound team; pat_revoke did not — so a team saw a token appear
  // for them and never saw it withdrawn, with the gap falling on the half somebody checks
  // AFTER a leak. Every other paired act already recorded both halves the same way, which is
  // what made the one exception invisible: nothing was wrong anywhere else to compare it to.
  //
  // Paired by name rather than by a list, so a new pair is covered the day it is written.
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
  // manifest-audit's own docstring says why it must not carry a second copy of a rule: an
  // audit that judges a store "against rules the platform never enforced" reports "defects
  // nobody has and misses the ones they do". It then carried one.
  //
  // closeCheck exempts every gate but the closing document's own when the outcome is a stop,
  // and says why: "an initiative that was dropped is precisely one whose gates were never
  // passed, so requiring them here would leave two options — approve a plan nobody agreed to,
  // or leave the initiative open forever". It also separates EXISTENCE from APPROVAL: a gated
  // document that was never written is requiredForClose's business, not the gate's.
  //
  // The audit merged both. Measured on a store holding one correctly abandoned ops-flow
  // initiative, it reported four defects and the platform has two of them.
  //
  // RUN, because this is about what the function concludes. The filesystem is injected, so
  // the fixture is a set of documents rather than a directory.
  const src = readFileSync(join(root, "packages/tools/src/testing/manifest-audit.ts"), "utf8");
  // `as readonly string[]` is this body's own TypeScript, stripped here rather than in
  // functionBody: the shared lifter drops the annotations every lifted body has, and a cast
  // one function happens to use is that function's business.
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
  // document to refuse a second close; ledgerOnClose reads it off the file on disk to refuse
  // a second row. Both guards are one field deep, so anything that can REMOVE that field
  // reopens the initiative and lets the close run again — and _ledger.md is what the OKR
  // grading and the cross-flow comparison count, so the same work is counted twice.
  //
  // document_revise did exactly that. It clears the governance fields so the gate goes back
  // to a person, and `outcome` was in that list alongside approved_by and approved_at — while
  // `closed_by` and `accepted_by` were left standing, so the document said who closed it and
  // nothing about what the close was. closeCheck fires only on content that HAS an outcome,
  // so no guard saw it. It now refuses the revision instead, and points at a journal node,
  // which is what initiative_close() says to do when a close was wrong.
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
  // And the one path that used to do it has to still refuse the case, or the rule above is
  // satisfied by a tool that simply writes the whole envelope back without the field.
  const rev = between(zzCoreSource(),
                      '"document_revise",', "server.registerTool(");
  const code = (rev.text ?? "").split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  if (!rev.text) {
    bad.push(`document_revise is no longer readable here: ${rev.why}`);
  } else if (!/env\.outcome\s*=\s*closedOutcome/.test(code)
             || !/const\s+closedOutcome\s*=\s*prevEnv\.outcome/.test(code)) {
    // CARRIED FORWARD, not refused. This used to require `if (prevEnv.outcome)` — a blanket
    // refusal of any revision to a closing document — which defended the ledger by making a
    // closed report uncorrectable. A report whose numbers were wrong stayed wrong, and the
    // remedy on offer was a journal node that nobody opening the report ever sees.
    //
    // The invariant that actually matters is narrower and stronger: whatever a revision does
    // to the prose, the field that says the initiative closed must come out the other side
    // unchanged. Then initiative_close() still refuses a second close and ledgerOnClose still returns
    // before appending, so the same work cannot be counted twice — and the text can still be
    // fixed, with the signed copy frozen in _versions/ and a person re-approving the new one.
    bad.push("document_revise does not carry `outcome` forward from the previous envelope — " +
             "read it into `closedOutcome` before the rebuild and write it back onto `env`. " +
             "Leaving the field merely untouched is not the same guarantee: it is the field " +
             "initiative_close() and ledgerOnClose both read to know an initiative already closed, and " +
             "the next edit to this function inherits nothing from an accident");
  }
  return bad.join("\n");
});

check("the closing document is resolved from the list the flow declared", () => {
  // NOT a source-order test. An earlier version compared where "closingDoc:" and "handover.md"
  // appear and was broken in both directions: the correct implementation writes closingDoc as
  // an ES6 shorthand with no trailing colon, so it read as "no longer computes closingDoc";
  // and a buggy one that appends first and recomputes from the augmented array put
  // "handover.md" earlier and passed.
  //
  // A behavioural test is not available: deriveChain is not exported (dist/server.d.ts is
  // `export {}`), and importing the module would bind port 8000 and open a Postgres connection
  // during a gate run. Today's manifests cannot exercise it either — all five qualifying flows
  // mark `closing` explicitly, so real catalog data never reaches the fallback. So this is
  // anchored on the VARIABLE the bug depends on, which statement reordering cannot defeat.
  // Stated as a heuristic, not as proof.
  const src = zzCoreSource();
  const at = src.indexOf("function deriveChain(");
  if (at < 0) return "deriveChain is gone or was renamed — every document list resolves through it";
  const body = src.slice(at, src.indexOf("\n}", at));
  const bad: string[] = [];
  if (!/closingDoc:\s*list\.find\(/.test(body)) {
    bad.push("closingDoc is not computed from the untouched `list` parameter — reading an augmented array makes an appended handover.md the closing document for any flow that marks none");
  }
  if (/\blist\s*=[^=]/.test(body)) {
    bad.push("`list` is reassigned inside deriveChain — the appended array must live under a different identifier, or the closing fallback can see it");
  }
  return bad.length ? bad.join("; ") : null;
});
