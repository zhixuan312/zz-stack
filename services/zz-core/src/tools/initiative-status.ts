/**
 * Reading an initiative: what state it is in, and whether what it predicted happened.
 *
 * `initiative_status` is computed from the flow's manifest and the documents' frontmatter,
 * never from a conversation, so the same initiative picked up on another harness continues
 * from where it stopped rather than from what anybody remembers.
 *
 * `knowledge_reconcile` returns the claims a stage recorded. Nothing joins them to telemetry.
 *
 * COUPLED: everything here is computed from `zz.initiative`, `zz.doc`, `zz.doc_revision` and the
 * initiative's own key/value state — there is no directory left to walk. What a document "is"
 * comes from the row the revision store holds, and what an initiative declares comes from the
 * row `initiative_open` wrote.
 */
import type pg from "pg";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { documentApplies, parseCaller, type Applicability, type FlowDoc } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { auditMove } from "../audit-rounds.js";
import { assessmentsFor, reviewMove } from "../review-rounds.js";
import { factsFor, recordsFor } from "../initiative-record.js";
import { chainFor } from "../chain.js";
import { type DocRow, docRows } from "../indexing.js";
import { planStructure, planStructureNote, type PlanStructure } from "../plan-structure.js";
import { isHandover, owedActs } from "../stage-records.js";
import { safeName } from "../paths.js";
import { Refusal } from "../refusal.js";
import { platformEvent } from "../indexing.js";
import { db, teamFor } from "../platform-db.js";
import { type Chain } from "../write-guards.js";

import { registerKnowledgeReconcileTool } from "./knowledge-reconcile.js";


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

/* ──────────────────────────────────────────────────────────────────────────────────────────
 * The document facts every computation below reads, taken from a `DocRow` map.
 *
 * DELIBERATE: one shape, one place. `envelopeOf` used to parse a file; the same seven keys —
 * status, outcome, closed_by, approved_by, approved_at, version and the open payload — are
 * columns of `zz.doc` and of the revision it points at, so `docFacts` names them ONCE and every
 * reader below is written against it rather than against a parse.
 * ────────────────────────────────────────────────────────────────────────────────────────── */

/** A document's envelope facts, or `{}` when this initiative holds no such document.
 *
 * COUPLED: an unresolved chain's `closingDoc` is the empty string, and the file version returned
 * `{}` for it (`readFileSync` of the directory threw EISDIR). A map lookup of a name nothing
 * holds answers `{}` for exactly the same reason. */
function docFacts(rows: Map<string, DocRow>, name: string): Record<string, string> {
  const d = rows.get(name);
  if (!d) return {};
  const env: Record<string, string> = {};
  if (d.status) env.status = d.status;
  if (d.outcome) env.outcome = d.outcome;
  if (d.closed_by) env.closed_by = d.closed_by;
  if (d.approved_by) env.approved_by = d.approved_by;
  if (d.approved_at) env.approved_at = d.approved_at;
  if (d.current_revision !== null) env.version = String(d.current_revision);
  if (d.flow) env.flow = d.flow;
  for (const [k, v] of Object.entries(d.fields ?? {})) env[k] = v;
  return env;
}

/** The documents an initiative holds under `sources/`, by their name inside it — the material
 *  `source_add` recorded, which is what an audit round and a review round are read out of. */
function sourceRows(rows: Map<string, DocRow>): DocRow[] {
  return [...rows.values()]
    .filter((d) => d.path.startsWith("sources/") && d.path.endsWith(".md"))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The initiative's registered sources, and which of them landed after the document they
 *  support was approved. Reached from both returns of initiativeState.
 *
 * Compares file mtimes, not the dates people type: `approved_at` is day-granular and
 * hand-written, while the approval snapshot in _versions/ and the source file both carry a
 * mtime the platform wrote itself. */
function sourceReport(rows: Map<string, DocRow>): {
  sourceFiles: string[];
  needsRefinement: Array<{ document: string; source: string; title: string }>;
} {
  const sources = sourceRows(rows);
  const sourceFiles = sources.map((d) => d.path.slice("sources/".length));
  // The two instants this compares are the database's own: when the source was last written and
  // when the document it bears on was approved. Both are timestamps the platform wrote, and
  // comparing them as instants rather than as text is what keeps two offsets from deciding.
  const at = (ts: string | null): number => (ts ? Date.parse(ts) : 0);
  const needsRefinement: Array<{ document: string; source: string; title: string }> = [];
  for (const src of sources) {
    if (!src.path.endsWith(".md")) continue;
    // An audit round lands on an approved document by design; the next move routes it.
    if (src.fields?.stage) continue;
    const sourceTime = at(src.updated_at);
    const supports = (src.fields?.supports || "").split(",").map((x) => x.trim()).filter(Boolean);
    for (const d of supports) {
      const target = rows.get(d);
      if (!target || target.status !== "approved") continue;
      if (sourceTime > at(target.approved_at)) {
        needsRefinement.push({ document: d, source: src.path,
                               title: src.title || src.path.slice("sources/".length) });
      }
    }
  }
  return { sourceFiles, needsRefinement };
}

/** What state an initiative is in, and what the next move is — the one computation both
 * `initiative_status` and `initiative_open` answer from.
 *
 * COUPLED: three queries and nothing else — the initiative's own row, its documents' rows, and
 * its key/value state. The directory listing, the envelope parses and the source-file walks this
 * used to do are all rows now, and `docFacts` is the one place a row becomes the envelope facts
 * every branch below reads.
 *
 * `next_move` is null exactly when nothing declared a chain, and `next_move_absent` says why
 * in that case and is undefined otherwise.
 *
 * `anchor`, when given, is this initiative's own row — the one query the no-argument listing
 * resolves for EVERY initiative at once, so it is not re-read once per initiative. Omitted, it
 * is read here, which is what the named form and `initiative_open` want. */
export async function initiativeState(
  p: pg.Pool, team: string | null, name: string, chain: Chain, docs: FlowDoc[],
  anchor?: InitiativeAnchor | null,
) {
  const rowList = team ? await docRows(p, team, name) : [];
  const rows = new Map(rowList.map((d) => [d.path, d]));
  // The initiative's own row: its flow, and whether and how it closed.
  const own = anchor !== undefined ? anchor : (await anchorsFor(p, team, [name])).get(name) ?? null;
  // No chain, so no next move — an answer rather than a gap. A freeform initiative is one
  // nobody drove with a flow: every document operation works, every gate still gates and the
  // close works, but there is no declared chain to read a next stage off. A flow cannot be
  // adopted after an initiative exists.
  //
  // The test is the empty chain, not a missing name: a named chain with no documents has
  // nothing to compute a next move over either. `chain.name` is therefore null whenever this
  // fires, which is what makes `flow: null` below the truth rather than a guess.
  if (docs.length === 0) {
    const files = [...rows.keys()].filter((f) => f.endsWith(".md") && !f.startsWith("_")).sort();
    // No manifest names a closing document, so the outcome is read off whichever document
    // carries one — where initiative_close wrote it.
    // COUPLED: the no-argument listing filters on `next_move.action === "closed"`.
    const envs: Array<{ name: string } & Record<string, string>> =
      files.map((f) => ({ name: f, ...docFacts(rows, f) }));
    const closer = envs.find((e) => e.outcome);
    // An initiative holding no document at all — opened by mistake, then abandoned — has no
    // document to read an outcome off; `initiative_close` records it on the row, so only the
    // anchor can say so.
    const abandonedAt = own?.closed_at ?? null;
    const abandonedBy = own?.closed_by ?? null;
    if (!closer && own?.outcome) {
      return {
        initiative: name, flow: own.flow, documents: envs, sources: 0,
        sources_after_approval: [],
        outcome: own.outcome, closed_by: abandonedBy ?? null,
        next_move: { action: "closed", waiting_on: "nobody",
                     why: `abandoned on ${abandonedAt ?? "an unrecorded date"} — it holds no ` +
                          "document, so the outcome is recorded on its own anchor row and no " +
                          "ledger row was appended" },
      };
    }
    // The same two source fields the governed return carries: freeform has no manifest but
    // still has sources, `source_add` still writes them, and `document_revise` still refuses a
    // revision that cites nothing.
    const freeSources = sourceReport(rows);
    return {
      initiative: name,
      flow: own?.flow ?? null,
      documents: envs,
      sources: freeSources.sourceFiles.length,
      sources_after_approval: freeSources.needsRefinement,
      outcome: own?.outcome ?? closer?.outcome ?? null,
      closed_by: own?.closed_by ?? closer?.closed_by ?? null,
      next_move: closer || own?.outcome
        // The one next move a freeform initiative has: read off the outcome already recorded,
        // not computed from a chain.
        ? { action: "closed", waiting_on: "nobody",
            why: `closed with outcome: ${own?.outcome ?? closer?.outcome}` }
        : null,
      // Stated, not left to be inferred from the null: "freeform, and that is fine" and "the
      // platform failed to compute one" want opposite reactions.
      next_move_absent: (closer || own?.outcome) ? undefined :
        "no flow governs this initiative, so there is no declared chain and therefore no " +
        "next stage to name. That is the answer, not a gap. NO GATE AND NO REQUIRED " +
        "DOCUMENT IS ENFORCED HERE — nothing is refused for want of an approval, and " +
        "nothing has to exist before this closes. Every act still WORKS and still records: " +
        "document_approve stamps a real approval, initiative_close writes a real outcome — " +
        "name the document it goes on, since no manifest does. A flow " +
        "cannot be adopted after an initiative exists; open a new one with `flow` if you " +
        "want its order and its gates enforced.",
    };
  }
  // FR-58 (Task I-26): read once, against every document's own `when` — an initiative's branch
  // facts are per-initiative, never per-flow, so they cannot live on the cached `chain` the way
  // `docs` does.
  const facts = await factsFor(p, team, name);
  const records = await recordsFor(p, team, name);
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
    const env = docFacts(rows, d.name);
    return {
      name: d.name, role: d.role, exists: rows.has(d.name),
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
  // The close is wherever initiative_close recorded it. A flow can move its closing document,
  // so an initiative closed earlier carries its outcome somewhere today's manifest may not
  // name — so the row's own outcome is read first, and the documents' payloads are the fallback
  // for a close that landed before the anchor row carried one.
  const closingEnv = ((): Record<string, string> => {
    if (own?.outcome) return {};
    const today = docFacts(rows, chain.closingDoc);
    if (today.outcome) return today;
    for (const f of [...rows.keys()].filter((x) => x.endsWith(".md") && !x.startsWith("_")).sort()) {
      const env = docFacts(rows, f);
      if (env.outcome) return env;
    }
    return today;
  })();
  const outcome = (own?.outcome || closingEnv.outcome) || null;
  const closedBy = (own?.closed_by || closingEnv.closed_by) || null;

  // the next move, in the flow's own declared order
  let next: { action: string; document?: string; stage?: string; waiting_on: string; why: string };
  // The current plan's structure: waves an executor may run in parallel, or why it cannot. Read
  // here because `current_phase` below decides which move the chain answers.
  //
  // COUPLED: the plan's own BODY, out of the row — `planStructure` validates text, and there is
  // no file to hand it.
  const planDoc = docs.find((d) => d.role === "plan");
  const plan: PlanStructure | undefined =
    planStructure(docs, planDoc ? rows.get(planDoc.name)?.body ?? null : null);
  // A plan that still declares a phase to build is mid-execution. `sdlc-execute` writes no
  // document and records nothing the platform can see, so nothing else in this function catches
  // it — and the review round would sweep a change that is a fraction built. `current_phase` is
  // that fact: the first phase with tasks and no `### As built`, null once every written phase is
  // built (`plan-structure.ts`).
  const executingPhase = plan?.current_phase ?? null;
  if (outcome) {
    // The platform appends the handover to every flow, whatever the flow declares, so what
    // gets captured does not depend on the flow author. It is not verified mid-flow: execute
    // and review happen in the caller's own terminal, which the platform cannot see.
    //
    // The handover is a knowledge node minted by zz-handover, not a document. Zero nodes is a
    // legitimate outcome, so the completion signal is handover.md's own approval, read
    // through the same `states` machinery as every other gated document.
    //
    // A closed initiative owes nothing: the close is the terminal act whatever it closed on.
    // The handover stays writeable afterwards — the guard in guards.ts lets a closed initiative
    // satisfy a prerequisite its close skipped.
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
             why: `closed with outcome: ${outcome}. Nothing further is owed — the row is ` +
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
    const sources = sourceRows(rows);
    // The answers already taken about this initiative's sources, in one query. A round's routing
    // depends on what `changes_commitment`/`repeats_finding` said, and those are `zz.assessment`
    // rows — the same memo every other reader of them uses, and not a second copy.
    const answers = team ? await assessmentsFor(p, team, name) : new Map();
    const owedAudit = (chain.stages ?? [])
      .filter((st): st is Extract<typeof st, { produces: "source" }> => st.produces === "source")
      .filter((st) => Boolean(st.supports) && appliesOf(st.supports as string) !== "not_applicable"
                     && requirementMet(st.supports as string))
      .map((st) => auditMove(name, st.name ?? "", st.supports as string,
                             rows.get(st.supports as string)?.current_revision ?? 1, sources, answers))
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
    const producedText = (doc: string): string => rows.get(doc)?.body ?? "";
    const owing = (st: (typeof stages)[number]): string[] =>
      st.produces.endsWith(".md") && appliesOf(st.produces) === "applies" &&
      requirementMet(st.produces) ? owedActs(records[st.name], name, producedText(st.produces)) : [];
    const unrecorded = stages.slice(0, writtenAt < 0 ? stages.length : writtenAt)
      .find((st) => st.produces === "record" ? !records[st.name] : owing(st).length > 0);
    // A document that `verifies` others owes its review rounds before it is written or awaited:
    // once its requirement is met and until it is approved, `reviewMove` routes the sweep, and
    // its null — the rounds settled — hands over to the ordinary write/await answer below. It is
    // not asked while a phase is still to build: a round offered there reviews an unfinished change.
    const verifying = flowDocs.find((d) => docs.find((x) => x.name === d.name)?.verifies?.length &&
      d.status !== "approved" && (!d.requires || requirementMet(d.requires)));
    const owedReview = verifying && executingPhase === null
      ? reviewMove(name, docs.find((x) => x.name === verifying.name)?.stage ?? "", verifying.name,
                   sources, answers)
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
    } else if (executingPhase !== null) {
      // NOT A TOOL: `run_stage` is `next_move.action`'s own vocabulary, like `resolve_branch`.
      //
      // This is the branch 0.83.2 adds. Without it the plan being approved was read as the plan
      // being built, so a seven-phase plan answered with a review round from its third phase on —
      // a full-scope sweep of a change that is a fraction written.
      const waves = (plan?.waves ?? []).map((w) => w.join(" + ")).join("; ");
      next = {
        action: "run_stage", stage: "sdlc-execute", waiting_on: "agent",
        why: `${plan?.document} declares phase ${executingPhase} still to build — run sdlc-execute ` +
             `for it${waves ? ` (its waves: ${waves})` : ""}, and the phase is built when it carries ` +
             `its \`### As built\`; ${verifying?.name ?? "the verifying document"} owes its review ` +
             "round once every phase is built",
      };
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
        why: `${pending.name} declares \`when\` over ${missing.join(", ")}, and the branch ` +
             `facts do not record ${missing.length === 1 ? "it" : "them"} yet — the stage that ` +
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
        .filter((n) => !rows.has(n));
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
  if (next.action !== "closed") {
    next.why += planStructureNote(plan, states.find((d) => d.name === plan?.document)?.status ?? null);
  }
  const { sourceFiles, needsRefinement } = sourceReport(rows);
  return { initiative: name,
           // The chain already knows which flow governs this initiative — it was resolved
           // to build `docs`. The row answers only when it does not.
           flow: chain.name ?? own?.flow ?? null,
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
const chainArgs = async (p: pg.Pool, team: string | null, name: string): Promise<[Chain, FlowDoc[]]> => {
  const chain = await chainFor(p, team, `${name}/x.md`);
  return [chain, chain.documents];
};

/** The anchor row for every named initiative, in one query — never one query per initiative.
 *  Null (no database, no team, or the row does not exist) reads as "no anchor", which is
 *  `initiativeState`'s cue to fall back to the file/envelope answer. */
async function anchorsFor(
  p: pg.Pool, team: string | null, names: readonly string[],
): Promise<Map<string, InitiativeAnchor>> {
  const out = new Map<string, InitiativeAnchor>();
  if (!team || !names.length) return out;
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
 *  DELIBERATE: a `Refusal` from one initiative is reported against that initiative, with its
 *  text, and the listing goes on — one initiative must not take down the listing of every other.
 *  Anything else still throws: an error nobody named is not a fact about one initiative. */
async function initiativeListing(
  p: pg.Pool, team: string | null, names: readonly string[], anchors?: Map<string, InitiativeAnchor>,
) {
  const open = [];
  let closedCount = 0;
  for (const name of names) {
    if (!(anchors?.has(name) ?? false)) {
      open.push({ initiative: name, error: "no such initiative" });
      continue;
    }
    let state;
    try {
      state = await initiativeState(p, team, name, ...await chainArgs(p, team, name), anchors?.get(name) ?? null);
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      open.push({ initiative: name, error: err.message });
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
export async function nextMoveLine(
  p: pg.Pool, team: string | null, initiative: string,
): Promise<string> {
  try {
    if (!initiative || !team) return "";
    const [chain, chainDocs] = await chainArgs(p, team, initiative);
    const move = (await initiativeState(p, team, initiative, chain, chainDocs)).next_move;
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
      const team = await teamFor(who.email);
      const p = db();
      if (!p || !team) {
        return text(
          "ERROR: no platform database, or a caller this deployment cannot place — an " +
          "initiative is a row now, so there is nothing to read without one."
        );
      }
      // The team's whole roster, or the one named. A slug the team does not hold is reported
      // per-initiative rather than refused, which is what the named form has always done.
      const names = initiative
        ? [initiative]
        : (await p.query<{ slug: string }>(
            `select i.slug from zz.initiative i join zz.team t on t.id = i.team_id
              where t.slug = $1 order by i.slug`, [team])).rows.map((r) => r.slug);
      // One query for every name in this call, never one per initiative.
      const anchors = await anchorsFor(p, team, names);
      // Named: that one initiative, and an unknown name says so — the caller asked about it.
      const base = initiative
        ? (anchors.has(initiative)
          ? await initiativeState(p, team, initiative, ...await chainArgs(p, team, initiative))
          : { initiative, error: "no such initiative" })
        : await initiativeListing(p, team, names, anchors);
      platformEvent({ actor: who.email, kind: "initiative_status", initiative: initiative ?? "*" });
      return text(JSON.stringify(base, null, 2));
    },
  );

  // The reconciliation reader is its own subject and its own module.
  registerKnowledgeReconcileTool(server);
}
