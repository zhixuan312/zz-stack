/**
 * Reading an initiative: what state it is in, and whether what it predicted happened.
 *
 * `initiative_status` is computed from the flow's manifest and the documents' frontmatter,
 * never from a conversation, so the same initiative picked up on another harness continues
 * from where it stopped rather than from what anybody remembers.
 *
 * `knowledge_reconcile` returns the claims a stage recorded. Nothing joins them to telemetry.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { documentApplies, OUTCOME_STOPPED, parseCaller, parseEnvelope, type Applicability,
         type FlowDoc } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { auditMove } from "../audit-rounds.js";
import { reviewMove } from "../review-rounds.js";
import { factsFor, openRecord, recordsFor } from "../initiative-record.js";
import { chainFor } from "../chain.js";
import { planStructure, planStructureNote, type PlanStructure } from "../plan-structure.js";
import { safeName, userRoot } from "../paths.js";
import { Refusal } from "../refusal.js";
import { logActivity } from "../persist.js";
import { db, teamFor } from "../platform-db.js";
import { type Chain } from "../write-guards.js";

/** The lifecycle facts `zz.initiative`'s anchor row carries (002_initiative_anchor.sql),
 *  resolved once by the async tool handler and handed to the (still synchronous)
 *  `initiativeState` below — see its own docstring for why the row is a parameter rather than
 *  a query this function makes itself.
 *
 *  `closed_by` is already the closer's email, joined from `zz.principal` by the caller: the
 *  column itself is a uuid, and this function's callers and its fixtures both deal in the
 *  email string every other field here already uses. */
interface InitiativeAnchor {
  flow: string | null;
  closed_at: string | null;
  closed_by: string | null;
  outcome: string | null;
}

interface DocState {
  name: string; role?: string; exists: boolean; status: string | null;
  gate: boolean; approved_by?: string; approved_at?: string; requires?: string;
  /** The headings this document must carry, when its flow declares any. `document_write`
   * refuses a body missing them, by name. Omitted, not empty, when a document declares none.
   *
   * COUPLED: chain.ts appends the handover's sections outside any flow manifest. */
  sections?: string[];
  /** FR-58 (Task I-26): set only for a document that declares `when` — a reader asking "where
   *  is protocol.md" deserves an answer, and a document with no `when` needs none: it always
   *  applies, which is exactly today's behaviour. */
  applies?: Applicability;
}

/** A document's frontmatter, or {} when there is no document there.
 *
 * DELIBERATE: the isFile() test stays. An unresolved chain's closingDoc is the empty string,
 * and join(dir, "") is the directory, which readFileSync throws EISDIR on. */
function envelopeOf(file: string): Record<string, string> {
  if (!existsSync(file) || !statSync(file).isFile()) return {};
  return parseEnvelope(readFileSync(file, "utf8"));
}

/** The initiative's registered sources, and which of them landed after the document they
 *  support was approved. Reached from both returns of initiativeState.
 *
 * Compares file mtimes, not the dates people type: `approved_at` is day-granular and
 * hand-written, while the approval snapshot in _versions/ and the source file both carry a
 * mtime the platform wrote itself. */
function sourceReport(dir: string, statusOf: (docName: string) => string | null): {
  sourceFiles: string[];
  needsRefinement: Array<{ document: string; source: string; title: string }>;
} {
  const srcDir = join(dir, "sources");
  const sourceFiles = existsSync(srcDir) ? readdirSync(srcDir).filter((f) => f.endsWith(".md")) : [];
  const approvalTime = (docName: string): number => {
    const vdir = join(dir, "_versions");
    let latest = 0;
    if (existsSync(vdir)) {
      const stem = docName.replace(/\.md$/, "") + ".v";
      for (const v of readdirSync(vdir)) {
        if (!v.startsWith(stem)) continue;
        latest = Math.max(latest, statSync(join(vdir, v)).mtimeMs);
      }
    }
    // no snapshot -> the document's own mtime is when it last changed, approval included
    return latest || (existsSync(join(dir, docName)) ? statSync(join(dir, docName)).mtimeMs : 0);
  };
  const needsRefinement: Array<{ document: string; source: string; title: string }> = [];
  for (const f of sourceFiles) {
    const env = parseEnvelope(readFileSync(join(srcDir, f), "utf8"));
    // An audit round lands on an approved document by design; the next move routes it.
    if (env.stage) continue;
    const sourceTime = statSync(join(srcDir, f)).mtimeMs;
    for (const d of (env.supports || "").split(",").map((x) => x.trim()).filter(Boolean)) {
      if (statusOf(d) !== "approved") continue;
      if (sourceTime > approvalTime(d)) {
        needsRefinement.push({ document: d, source: `sources/${f}`, title: env.title || f });
      }
    }
  }
  return { sourceFiles, needsRefinement };
}

/** What a stage's record says it still owes, first first, each as the sentence `next_move.why`
 *  carries. Empty for a record that owes nothing or has discharged it.
 *
 *  COUPLED: the record shape eval/stage-record.ts writes — `owes`, one key per act once it
 *  lands, `qualify_owed` and `qualified.<measure>`. Read here rather than imported: the
 *  evaluation modules are reached from the evaluation side only (checks/eval-tools-moved.ts). */
function owedActs(
  record: Readonly<Record<string, string>> | undefined, initiative: string,
  /** The document the stage produced, as it stands now. */
  produced: string,
): string[] {
  if (!record?.owes) return [];
  // Bound to a version the document no longer quotes: it was revised to a newer protocol version,
  // and that version is neither bound nor qualified, whatever this record says of the old one.
  const stale = !!record.affirmed_digest && !produced.includes(record.affirmed_digest);
  if (stale) {
    return [`protocol.md now quotes a protocol version this initiative has not bound — call ` +
      `protocol_affirm with that version (initiative: "${initiative}"), then evaluator_qualify for ` +
      "each model-backed measure it names, before EVALUATE scores"];
  }
  const owed = (record.qualify_owed ?? "").split(",").filter(Boolean)
    .filter((k) => !record[`qualified.${k}`]);
  // Not protocol_read's: on a revise it answers the version being replaced, and binding that one
  // would affirm the old protocol under the new document.
  const version = record.protocol_version_id ?? "<the protocol_version_id protocol_record returned, the version protocol.md quotes>";
  const why: Record<string, string> = {
    protocol_affirm: `protocol.md is approved but not bound to the protocol — call protocol_affirm("${version}", ` +
      `initiative: "${initiative}"). Nothing qualifies or scores against an unaffirmed version`,
    evaluator_qualify: `the affirmed protocol's model-backed evaluators are not all qualified — call ` +
      `evaluator_qualify("${version}", measure_key, initiative: "${initiative}") for ` +
      `${owed.length ? owed.join(", ") : "each model-backed measure"} before EVALUATE scores`,
  };
  return record.owes.split(",").filter((act) => act && !record[act]).map((act) => why[act] ?? `call ${act}`);
}

/** The platform's own closing step, told apart from the flow's own documents.
 *
 * `deriveChain` appends it with `role: "handover"`; a flow that declares its own is matched
 * by name. One branch below must skip it and another must find it, and both go through this
 * one test. */
function isHandover(d: { name: string; role?: string }): boolean {
  return d.role === "handover" || d.name === "handover.md";
}

/** What state an initiative is in, and what the next move is — the one computation both
 * `initiative_status` and `initiative_open` answer from.
 *
 * Exported and taking `root` explicitly so it can be run over a fixture store.
 * COUPLED: `checks/initiative-open.ts` drives it.
 *
 * `next_move` is null exactly when nothing declared a chain, and `next_move_absent` says why
 * in that case and is undefined otherwise.
 *
 * `anchor`, when given, is `zz.initiative`'s own row (002_initiative_anchor.sql, Task I-6):
 * flow, abandonment and outcome are read from it rather than from `_open.json` or a document's
 * envelope. Optional and trailing, so this stays a synchronous function a fixture-driven check
 * can call directly with no database at all (`checks/initiative-open.ts` and its neighbours) —
 * they get today's file/envelope-derived answer; the registered tools below resolve the row
 * first and pass it in. */
export function initiativeState(
  root: string, name: string, chain: Chain, docs: FlowDoc[], anchor?: InitiativeAnchor | null,
) {
  const dir = join(root, name);
  // No chain, so no next move — an answer rather than a gap. A freeform initiative is one
  // nobody drove with a flow: every document operation works, every gate still gates and the
  // close works, but there is no declared chain to read a next stage off. A flow cannot be
  // adopted after an initiative exists.
  //
  // The test is the empty chain, not a missing name: a named chain with no documents has
  // nothing to compute a next move over either. `chain.name` is therefore null whenever this
  // fires, which is what makes `flow: null` below the truth rather than a guess.
  if (docs.length === 0) {
    const files = existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("_")).sort()
      : [];
    // No manifest names a closing document, so the outcome is read off whichever document
    // carries one — where initiative_close wrote it.
    // COUPLED: the no-argument listing filters on `next_move.action === "closed"`.
    const envs: Array<{ name: string } & Record<string, string>> =
      files.map((f) => ({ name: f, ...envelopeOf(join(dir, f)) }));
    const closer = envs.find((e) => e.outcome);
    // An initiative holding no document at all — opened by mistake, then abandoned — has no
    // envelope to read an outcome off. `anchor`, when given, is authoritative (the row is where
    // `initiative_close` now records this); with no database, `openRecord`'s file is what
    // `initiative_close` still falls back to for the same fact.
    const rec = anchor ? null : openRecord(root, name);
    const declaredFlow = anchor ? anchor.flow : (rec?.flow ?? null);
    const abandonedAt = anchor ? anchor.closed_at : (rec?.abandoned_at ?? null);
    const abandonedBy = anchor ? anchor.closed_by : (rec?.abandoned_by ?? null);
    if (!closer && abandonedAt) {
      return {
        initiative: name, flow: declaredFlow, documents: envs, sources: 0,
        sources_after_approval: [],
        outcome: OUTCOME_STOPPED, closed_by: abandonedBy ?? null,
        next_move: { action: "closed", waiting_on: "nobody",
                     why: `abandoned on ${abandonedAt} — it holds no document, so the outcome ` +
                          "is recorded on its own anchor row and no ledger row was appended" },
      };
    }
    // The same two source fields the governed return carries: freeform has no manifest but
    // still has a `sources/` directory, `source_add` still writes into it, and
    // `document_revise` still refuses a revision that cites nothing.
    const freeSources = sourceReport(dir, (d) => envs.find((e) => e.name === d)?.status ?? null);
    return {
      initiative: name,
      flow: declaredFlow,
      documents: envs,
      sources: freeSources.sourceFiles.length,
      sources_after_approval: freeSources.needsRefinement,
      outcome: closer?.outcome ?? null,
      closed_by: closer?.closed_by ?? null,
      next_move: closer
        // The one next move a freeform initiative has: read off the outcome already written
        // down, not computed from a chain.
        ? { action: "closed", waiting_on: "nobody",
            why: `closed with outcome: ${closer.outcome}` }
        : null,
      // Stated, not left to be inferred from the null: "freeform, and that is fine" and "the
      // platform failed to compute one" want opposite reactions.
      next_move_absent: closer ? undefined :
        "no flow governs this initiative, so there is no declared chain and therefore no " +
        "next stage to name. That is the answer, not a gap. NO GATE AND NO REQUIRED " +
        "DOCUMENT IS ENFORCED HERE — nothing is refused for want of an approval, and " +
        "nothing has to exist before this closes. Every act still WORKS and still records: " +
        "document_approve stamps a real approval, initiative_close writes a real outcome and " +
        "a real ledger row — name the document it goes on, since no manifest does. A flow " +
        "cannot be adopted after an initiative exists; open a new one with `flow` if you " +
        "want its order and its gates enforced.",
    };
  }
  // FR-58 (Task I-26): read once, against every document's own `when` — `_facts.json` is
  // per-initiative, never per-flow, so it cannot live on the cached `chain` the way `docs` does.
  const facts = factsFor(root, name);
  const records = recordsFor(root, name);
  const appliesOf = (docName: string): Applicability => {
    const spec = docs.find((d) => d.name === docName);
    return spec?.when ? documentApplies(spec, facts) : "applies";
  };
  // The document this branch closes on. `chain.closingDoc` is per flow, and a `when`-conditional
  // one (zz-plugin-eval's improvement.md, promotable only) is ruled out on every other branch,
  // which then closes on the furthest document it applies — proposal.md, or findings.md.
  // COUPLED: the `close` move below and initiative_close (initiative-close.ts) land there too.
  const branchClosing = ((): string => {
    if (!chain.closingDoc || appliesOf(chain.closingDoc) !== "not_applicable") return chain.closingDoc;
    const applies = docs.filter((d) => !isHandover(d) && appliesOf(d.name) !== "not_applicable");
    return applies[applies.length - 1]?.name ?? chain.closingDoc;
  })();
  const states: DocState[] = docs.map((d) => {
    const env = envelopeOf(join(dir, d.name));
    return {
      name: d.name, role: d.role, exists: existsSync(join(dir, d.name)),
      status: env.status ?? null, gate: !!d.gate,
      approved_by: env.approved_by || undefined, approved_at: env.approved_at || undefined,
      // The handover follows whichever document closes this branch, not the flow's declared one:
      // on a branch that rules improvement.md out, "requires improvement.md" names a document
      // that will never exist.
      requires: isHandover(d) && d.requires ? branchClosing || d.requires : d.requires,
      sections: d.sections?.length ? d.sections : undefined,
      applies: d.when ? documentApplies(d, facts) : undefined,
    };
  });
  // The close is wherever initiative_close wrote it. A flow can move its closing document, so
  // an initiative closed earlier carries its outcome on a document today's manifest does not
  // name. Only initiative_close writes an outcome — and, with a database, it writes the anchor
  // row in the same call, which is what this reads first. `closingEnv` stays the fallback for a
  // caller with no row to hand in (the fixture-driven checks).
  const closingEnv = ((): Record<string, string> => {
    if (anchor) return {};
    const today = envelopeOf(join(dir, chain.closingDoc));
    if (today.outcome || !existsSync(dir)) return today;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".md") && !x.startsWith("_")).sort()) {
      const env = envelopeOf(join(dir, f));
      if (env.outcome) return env;
    }
    return today;
  })();
  const outcome = (anchor ? anchor.outcome : closingEnv.outcome) || null;
  // Who recorded the close, beside what it was. With a database this is the anchor row's
  // `closed_by`, joined back to an email by the caller; without one it is the closing
  // document's envelope, stamped by initiative_close().
  const closedBy = (anchor ? anchor.closed_by : closingEnv.closed_by) || null;

  // the next move, in the flow's own declared order
  let next: { action: string; document?: string; stage?: string; waiting_on: string; why: string };
  if (outcome) {
    // The platform appends the handover to every flow, whatever the flow declares, so what
    // gets captured does not depend on the flow author. It is not verified mid-flow: execute
    // and review happen in the caller's own terminal, which the platform cannot see.
    //
    // The handover is a knowledge node minted by zz-handover, not a file. Zero nodes is a
    // legitimate outcome, so the completion signal is handover.md's own approval, read
    // through the same `states` machinery as every other gated document.
    //
    // A closed initiative owes nothing: the close is the terminal act whatever it closed on,
    // and the ledger row is the record. The handover stays writeable afterwards — the guard
    // in guards.ts lets a closed initiative satisfy a prerequisite its close skipped.
    //
    // The note states what is true of this initiative's handover, and a flow that declares
    // no handover at all is closed rather than stuck.
    const handover = states.find(isHandover);
    const handoverNote = handover?.status === "approved"
      ? `The handover is recorded: ${handover.name} was approved by ${handover.approved_by ?? "somebody"}` +
        `${handover.approved_at ? ` on ${handover.approved_at}` : ""}.`
      : handover?.exists
        ? `${handover.name} is written and waiting on a verdict — \`document_approve\` records it, ` +
          "and nothing is owed either way."
        : "If the cycle taught something worth keeping, `skill_read(\"zz-handover\")` mints it and " +
          "writes handover.md; the close satisfies that document's prerequisite.";
    next = { action: "closed", waiting_on: "nobody",
             why: `closed with outcome: ${outcome}. Nothing further is owed — the ledger row is ` +
                  `the record. ${handoverNote}` };
  } else {
    // A requirement is met by the only thing its target can offer. Nothing ever approves a
    // non-gated document — `gate: false` means no approval is required, so its status stays
    // `draft` for the life of the initiative — so a gated target must be approved and an
    // ungated one need only exist.
    //
    // FR-58 (Task I-26): a requirement ruled out by the branch (`not_applicable`) is met without
    // existing at all — it was excluded, not merely unwritten. A requirement whose own branch is
    // `undetermined` is the opposite: NOT met, because the platform has not yet decided whether
    // it is required — a different wait from "unapproved", which `pending` below tells apart.
    // COUPLED: `gateCheck` in guards.ts applies the same two rules to a write, not just a read.
    const requirementMet = (docName: string): boolean => {
      const applic = appliesOf(docName);
      if (applic === "not_applicable") return true;
      if (applic === "undetermined") return false;
      const t = states.find((x) => x.name === docName);
      if (!t) return false;
      return t.gate ? t.status === "approved" : t.exists;
    };
    // The handover is not one of the flow's documents, and this branch is the flow.
    // `deriveChain` appends handover.md with `requires: <the closing document>`, satisfied
    // the moment that gate is recorded, so `pending` would otherwise select it before the
    // close was ever considered. Excluded by role, so a flow declaring its own handover gets
    // the same treatment. The closed branch above owns this document entirely — it is the
    // only place that can know the outcome it reports on.
    //
    // A document the branch has ruled out is excluded from the search entirely (FR-58): it is
    // never "the next document this flow declares", never awaited, never owed an audit — the
    // same as if the flow had simply never declared it.
    const flowDocs = states.filter((d) => !isHandover(d) && appliesOf(d.name) !== "not_applicable");
    const pending = flowDocs.find((d) => !d.exists && (!d.requires || requirementMet(d.requires)));
    const awaiting = flowDocs.find((d) => d.exists && d.gate && d.status !== "approved");
    // A stage that produces a source is a stage, and `states` is built from the manifest's
    // `documents` alone. sdlc-flow's two audits evidence themselves with rounds — sources naming
    // their stage and supporting the document they audited — and the reviewed module asks each
    // audit step for `1x audit`, so the close refuses an initiative whose audits never ran.
    // How many rounds, and whether the stakeholder is owed a decision, is `auditMove`'s answer.
    //
    // COUPLED: read from the manifest's stages, in their declared order, the same rule
    // `enrolment.ts` follows for the evidence side. The two answers about one flow have to agree.
    //
    // `requirementMet` alone is not enough here: it reads `not_applicable` as discharged
    // (true), which is right for a document another one merely *requires*, but an audit of a
    // ruled-out document is not owed at all — it is excluded explicitly, first.
    const owedAudit = (chain.stages ?? [])
      .filter((st): st is Extract<typeof st, { produces: "source" }> => st.produces === "source")
      .filter((st) => Boolean(st.supports) && appliesOf(st.supports as string) !== "not_applicable"
                     && requirementMet(st.supports as string))
      .map((st) => auditMove(root, name, st.name ?? "", st.supports as string,
                             Number(envelopeOf(join(dir, st.supports as string)).version) || 1))
      .find((m): m is NonNullable<typeof m> => m !== null);
    // A stage that produces a `record` writes no document, so `pending` cannot see it. The first
    // such stage ahead of the pending document's own stage that has recorded nothing is what runs
    // next — without this a fresh conversation got the same answer before IDENTIFY as after
    // DISCOVER. Each record stage's tool writes its record when handed the initiative.
    const stages = chain.stages ?? [];
    const writtenAt = pending ? stages.findIndex((st) => st.name === docs.find((d) => d.name === pending.name)?.stage) : -1;
    //
    // A stage whose document is settled can still owe acts no document records — DEFINE/QUALIFY's
    // protocol_affirm and evaluator_qualify once protocol.md is approved (stage-record.ts). Its
    // record names them, and a stage with one still missing is unfinished the same way.
    const producedText = (doc: string): string => {
      const file = join(dir, doc);
      return existsSync(file) && statSync(file).isFile() ? readFileSync(file, "utf8") : "";
    };
    const owing = (st: (typeof stages)[number]): string[] =>
      st.produces.endsWith(".md") && appliesOf(st.produces) === "applies" &&
      requirementMet(st.produces) ? owedActs(records[st.name], name, producedText(st.produces)) : [];
    const unrecorded = stages.slice(0, writtenAt < 0 ? stages.length : writtenAt)
      .find((st) => st.produces === "record" ? !records[st.name] : owing(st).length > 0);
    // A document that `verifies` others owes its review rounds before it is written or awaited:
    // once its requirement is met and until it is approved, `reviewMove` routes the sweep, and
    // its null — the rounds settled — hands over to the ordinary write/await answer below.
    const verifying = flowDocs.find((d) => docs.find((x) => x.name === d.name)?.verifies?.length &&
      d.status !== "approved" && (!d.requires || requirementMet(d.requires)));
    const owedReview = verifying
      ? reviewMove(root, name, docs.find((x) => x.name === verifying.name)?.stage ?? "", verifying.name)
      : null;
    const awaitApproval = (d: DocState) => ({
      action: "await_approval", document: d.name, waiting_on: "stakeholder",
      why: `${d.name} is ${d.status ?? "unwritten"}; call document_approve("${name}/${d.name}") ` +
           "once the stakeholder agrees — nothing downstream may be written until that gate is recorded",
    });
    if (awaiting && awaiting.name !== owedReview?.document) {
      next = awaitApproval(awaiting);
    } else if (unrecorded && unrecorded.produces !== "record") {
      next = {
        action: "run_stage", stage: unrecorded.name, waiting_on: "agent",
        why: `${unrecorded.name} is not finished: ${owing(unrecorded)[0]}`,
      };
    } else if (unrecorded) {
      // NOT A TOOL: `run_stage` is `next_move.action`'s own vocabulary, like `resolve_branch`.
      next = {
        action: "run_stage", stage: unrecorded.name, waiting_on: "agent",
        why: `${unrecorded.name} produces a record and has recorded nothing for this initiative — ` +
             `skill_read("${unrecorded.name}") and run it, passing initiative: "${name}" to the ` +
             "call that records it; what it records appears here under `records`",
      };
    } else if (owedAudit) {
      // NOT A TOOL: `add_source` and `decide` are members of `next_move.action`'s own
      // vocabulary, not tool names. The `why` beside each names the call to make.
      next = owedAudit;
    } else if (owedReview) {
      // NOT A TOOL: `fix` and `run_experiment` join `add_source` and `decide` in the same
      // vocabulary; review-rounds.ts says what each asks for.
      next = owedReview;
    } else if (awaiting) {
      next = awaitApproval(awaiting);
    } else if (pending && appliesOf(pending.name) === "undetermined") {
      // FR-58 (Task I-26): `pending` is the next document in the flow's order, but its OWN
      // branch has not resolved — not a fact about approval or about a stage owing evidence,
      // so neither `write_document` nor `await_approval` fits. `resolve_branch` is the fourth
      // agent-facing verb, beside `write_document`, `add_source` and `decide`.
      const missing = Object.keys(docs.find((d) => d.name === pending.name)?.when ?? {})
        .filter((fact) => !facts[fact]);
      next = {
        action: "resolve_branch", document: pending.name, waiting_on: "agent",
        why: `${pending.name} declares \`when\` over ${missing.join(", ")}, and _facts.json ` +
             `does not record ${missing.length === 1 ? "it" : "them"} yet — the stage that ` +
             `decides the branch has to run before ${pending.name} can be written one way or ` +
             "the other",
      };
    } else if (pending) {
      next = { action: "write_document", document: pending.name, waiting_on: "agent",
               why: `${pending.name} is the next document this flow declares` };
    } else {
      // A `requiredForClose` document the branch has ruled out is not owed either — the same
      // FR-58 exclusion `flowDocs` applies above, applied here to `closeRequires`.
      const missing = chain.closeRequires
        .filter((n) => appliesOf(n) !== "not_applicable")
        .filter((n) => !existsSync(join(dir, n)));
      next = missing.length
        ? { action: "write_document", document: missing[0], waiting_on: "agent",
            why: `${missing[0]} is required before this initiative can close` }
        // NOT A TOOL: `next_move.action` is its own vocabulary — declare_flow,
        // write_document, await_approval, add_source, decide, fix, run_experiment,
        // resolve_branch, handover, closed, close — not tool names. The `why` beside it names the tool to call.
        //
        // FR-58 (Task I-28): `chain.closingDoc` is a static, per-flow answer, and a
        // `when`-conditional closing document (`improvement.md`, promotable only) is
        // `not_applicable` on every other branch — the same question `initiative_close`
        // (initiative-close.ts) and `closeCheck` (guards.ts) both ask before deciding where a
        // close actually lands, asked here too so this call never names a document those two
        // would refuse to close on. By construction of this `else` arm every document that
        // applies exists, so `branchClosing` IS the furthest document this branch wrote.
        : { action: "close", document: branchClosing,
            waiting_on: "agent",
            // Every gate being recorded is a statement about approvals; acceptance is a
            // different act by a different person, so the `why` has to name both.
            why: "every declared document exists and every gate is recorded — close it " +
                 `with initiative_close("${name}", "finished") once somebody has accepted, naming ` +
                 "them in `accepted_by`. The outcome is DERIVED from that: with an " +
                 "acceptor it is `accepted`; without one it is `delivered` and owes one " +
                 "line on why nobody signed off. You do not write `outcome`, and the " +
                 "platform refuses it by hand. If nobody has accepted yet, that is what " +
                 "is outstanding, not this call" };
    }
  }
  // The current plan's structure: waves an executor may run in parallel, or why it cannot.
  const plan: PlanStructure | undefined = planStructure(dir, docs);
  if (next.action !== "closed") {
    next.why += planStructureNote(plan, states.find((d) => d.name === plan?.document)?.status ?? null);
  }
  const { sourceFiles, needsRefinement } =
    sourceReport(dir, (d) => states.find((x) => x.name === d)?.status ?? null);
  return { initiative: name,
           // The chain already knows which flow governs this initiative — it was resolved
           // to build `docs`. The envelope fallback answers only when it does not.
           flow: chain.name ?? (envelopeOf(join(dir, docs[0]?.name ?? "")).flow || null),
           documents: states, outcome, closed_by: closedBy, sources: sourceFiles.length,
           // reported, never enforced: material that landed after an approval may warrant
           // a revision — the team decides, and document_revise is how they do it
           sources_after_approval: needsRefinement,
           // Omitted when empty: only a flow with `produces: "record"` stages writes any.
           records: Object.keys(records).length ? records : undefined,
           // Omitted when the flow declares no plan or it is not written yet.
           plan, next_move: next,
           // Undefined rather than absent, so the two returns of this function have one
           // shape and a caller can read the field without knowing which branch answered.
           next_move_absent: undefined as string | undefined };
}

const chainArgs = (root: string, name: string): [Chain, FlowDoc[]] => {
  const chain = chainFor(root, `${name}/x.md`);
  return [chain, chain.documents];
};

/** The anchor row for every named initiative, in one query — never one query per initiative.
 *  Null (no database, no team, or the row does not exist) reads as "no anchor", which is
 *  `initiativeState`'s cue to fall back to the file/envelope answer. */
async function anchorsFor(
  team: string | null, names: readonly string[],
): Promise<Map<string, InitiativeAnchor>> {
  const out = new Map<string, InitiativeAnchor>();
  const p = db();
  if (!p || !team || !names.length) return out;
  const { rows } = await p.query<{ slug: string; flow: string | null; closed_at: string | null;
    closed_by: string | null; outcome: string | null }>(
    `select i.slug, i.flow, i.closed_at::text, pc.email as closed_by, i.outcome
       from zz.initiative i
       join zz.team t on t.id = i.team_id
       left join zz.principal pc on pc.id = i.closed_by
      where t.slug = $1 and i.slug = any($2::text[])`,
    [team, names]);
  for (const r of rows) {
    out.set(r.slug, { flow: r.flow, closed_at: r.closed_at, closed_by: r.closed_by, outcome: r.outcome });
  }
  return out;
}

/** The no-argument `initiative_status`: every OPEN initiative, and a count of the closed ones.
 *  Closed ones are counted rather than dropped, so a filtered answer is not mistaken for an
 *  empty one.
 *
 *  DELIBERATE: a `Refusal` from one initiative (a damaged `_facts.json`, which `factsFor`
 *  refuses by name) is reported against that initiative, with its text, and the listing goes
 *  on — one folder must not take down the listing of every initiative beside it. Anything else
 *  still throws: an error nobody named is not a fact about one initiative. */
export function initiativeListing(
  root: string, names: readonly string[], anchors?: Map<string, InitiativeAnchor>,
) {
  const open = [];
  let closedCount = 0;
  for (const name of names) {
    if (!existsSync(join(root, name))) {
      open.push({ initiative: name, error: "no such initiative" });
      continue;
    }
    let state;
    try {
      state = initiativeState(root, name, ...chainArgs(root, name), anchors?.get(name) ?? null);
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      open.push({ initiative: name, damaged: true, error: err.message });
      continue;
    }
    // DELIBERATE: optional-chained — `next_move` is null for a freeform initiative, and one
    // such folder would otherwise take down the listing of every initiative beside it.
    if (state.next_move?.action === "closed") { closedCount++; continue; }
    open.push(state);
  }
  return { open, closed_not_listed: closedCount };
}

/** The next move, as one line appended to the result of a tool that just changed an
 *  initiative — so a caller who never asks `initiative_status` is still told what the flow
 *  expects next. Empty for a freeform initiative, a closed one, or a name that is not one. */
export function nextMoveLine(root: string, initiative: string): string {
  try {
    if (!initiative || !existsSync(join(root, initiative))) return "";
    const chain = chainFor(root, `${initiative}/x.md`);
    const move = initiativeState(root, initiative, chain, chain.documents).next_move;
    if (!move || move.action === "closed") return "";
    return `\n\nNext move: ${move.action}${"document" in move && move.document ? ` ${move.document}` : ""}` +
           ` (waiting on ${move.waiting_on}) — ${move.why}`;
  } catch { return ""; }
}

export function registerInitiativeStatusTools(server: McpServer): void {

  server.registerTool(
    "initiative_status",
    {
      description:
        "Where an initiative stands and WHAT THE NEXT MOVE IS, computed from the flow's manifest " +
        "and the documents' frontmatter — not from memory or from this conversation. Call it " +
        "before continuing any existing work, especially work someone started elsewhere (another " +
        "chat, another client): the initiative is the unit of work, and this is the " +
        "one answer every harness shares. Omit `initiative` to get every OPEN initiative, with " +
        "a count of the closed ones it did not list; name one to get it whatever its state.",
      inputSchema: { initiative: z.string().optional() },
    },
    async ({ initiative }) => {
      if (initiative) {
        const bad = safeName(initiative, "initiative");
        if (bad) return text(bad);
      }
      const who = parseCaller(requestHeaders());
      const root = await userRoot();
      const names = initiative
        ? [initiative]
        // Dot-entries are not initiatives, and the store is a git repository, so there is a
        // `.git` in every root. COUPLED: walk() in @zz/indexing applies the same filter.
        : readdirSync(root).filter((n) => !n.startsWith("_") && !n.startsWith(".") &&
            !n.endsWith(".md") && statSync(join(root, n)).isDirectory());
      const team = await teamFor(who.email);
      // One query for every name in this call, never one per initiative — a caller with no
      // database or no team reads back an empty map, and every initiative falls back to its
      // file/envelope answer exactly as it did before the anchor row existed.
      const anchors = await anchorsFor(team, names);
      // Named: that one initiative, and a damaged one refuses — the caller asked about it.
      const base = initiative
        ? (existsSync(join(root, initiative))
          ? initiativeState(root, initiative, ...chainArgs(root, initiative), anchors.get(initiative) ?? null)
          : { initiative, error: "no such initiative" })
        : initiativeListing(root, names, anchors);
      // How many of this initiative's documents `indexDoc` has already stamped with
      // `initiative_id` (packages/indexing/src/index.ts, Task I-6) against how many it holds —
      // reported only for a named initiative, since it is one extra query nobody asked for on
      // the whole-store listing. `tagged === total` is the observable proof that a document
      // written into an open initiative carries `initiative_id` immediately, with no reindex or
      // reconciler in between; there is no other MCP surface for that column.
      let docIndex: { total: number; tagged: number } | undefined;
      const p = db();
      if (initiative && p && team && !("error" in base)) {
        const cov = (await p.query<{ total: string; tagged: string }>(
          `select count(*)::text as total, count(d.initiative_id)::text as tagged
             from zz.doc d join zz.team t on t.slug = d.team_slug
            where t.slug = $1 and d.initiative = $2`,
          [team, initiative])).rows[0];
        if (cov) docIndex = { total: Number(cov.total), tagged: Number(cov.tagged) };
      }
      const answer = docIndex ? { ...base, doc_index: docIndex } : base;
      logActivity(root, null, { user: who.email, action: "initiative_status", initiative: initiative ?? "*" });
      return text(JSON.stringify(answer, null, 2));
    },
  );

  server.registerTool(
    "knowledge_reconcile",
    {
      description:
        "What a stage committed to, for one initiative: the fit ledger keyed by acceptance " +
        "criterion, the criteria themselves and who verifies each, as the stage recorded them. " +
        "Ask by `initiative`. It returns the claims only — nothing records which plugin a claim " +
        "is about, so nothing joins them to tool-call telemetry.",
      inputSchema: {
        initiative: z.string().min(1).describe("Reconcile this one initiative."),
      },
    },
    async ({ initiative }) => {
      const p = db();
      if (!p) return text("ERROR: no platform database — reconciliation reads zz.decision");

      const who = parseCaller(requestHeaders());
      const team = await teamFor(who.email);
      if (!team) return text("ERROR: no team — reconciliation is scoped to the team that made the predictions");
      const bad = safeName(initiative, "initiative");
      if (bad) return text(bad);
      // What was claimed. Rows are derived at index time from text the flow already wrote, so
      // this reads the flow's own words rather than a second record of them.
      const { rows: claims } = await p.query<{
        initiative: string; path: string; role: string; key: string;
        verdict: string; qualifier: string; detail: string; checker: string;
      }>(
        `select initiative, path, role, key, verdict, qualifier, detail, checker
           from zz.decision d where d.team_slug = $1 and d.initiative = $2
          order by initiative, path, key`,
        [team, initiative]);
      if (!claims.length) {
        return text(`No claims recorded for ${initiative}. A stage records them by writing its fit ledger or its acceptance criteria; nothing to reconcile until one has.`);
      }

      // Claims only: nothing records which plugin a claim is about, so nothing joins these to
      // `zz.event`.
      const out = claims.map((c) => ({
        initiative: c.initiative,
        key: c.key,
        predicted: { verdict: c.verdict, qualifier: c.qualifier || null, by: c.detail || null,
                     verified_by: c.checker || null },
      }));
      return text(JSON.stringify({
        team,
        scope: { initiative },
        claims: out.length,
        note: "What a stage predicted, in the flow's own words. Nothing records which plugin a " +
              "claim is about, so a claim listed here has not been checked against anything.",
        claims_recorded: out,
      }, null, 2));
    },
  );
}
