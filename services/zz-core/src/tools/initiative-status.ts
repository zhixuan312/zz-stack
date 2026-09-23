/**
 * Reading an initiative: what state it is in, and whether what it predicted happened.
 *
 * `initiative_status` is computed from the flow's manifest and the documents' frontmatter —
 * never from a conversation — which is what lets the same initiative be picked up in another
 * chat, by another person, on another harness, and continue from where it stopped rather
 * than from what anybody remembers.
 *
 * `knowledge_reconcile` asks the other half: the stages PREDICTED certain blocks would be called, and
 * the gateway recorded what actually was. The gap between the two, refusal text included, is
 * the most useful thing an initiative leaves behind.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OUTCOME_STOPPED, parseCaller, parseEnvelope, type FlowDoc } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { openRecord } from "../initiative-record.js";
import { chainFor } from "../chain.js";
import { safeName, userRoot } from "../paths.js";
import { logActivity } from "../persist.js";
import { db, teamFor } from "../platform-db.js";
import { type Chain } from "../write-guards.js";

interface DocState {
  name: string; role?: string; exists: boolean; status: string | null;
  gate: boolean; approved_by?: string; approved_at?: string; requires?: string;
  /** THE HEADINGS THIS DOCUMENT MUST CARRY, when its flow declares any.
   *
   * document_write REFUSES a body missing them, by name — and until this was returned here
   * there was no way to ask what they were. A caller learned the list by being refused, one
   * document at a time, which is a rule you can only discover by breaking it. The flow
   * declares them; the platform enforces them; this is the platform saying so first.
   *
   * It covers the handover too, whose sections are appended by chain.ts rather than written
   * in any flow's manifest — so a caller reading a catalog file would still not have found
   * them. Omitted, rather than empty, when a document declares none. */
  sections?: string[];
}

/** A document's frontmatter, or {} when there is no document there.
 *
 * The isFile() test is not defensive padding. When a chain cannot be resolved its
 * closingDoc is the empty string, and join(dir, "") is the DIRECTORY — so this read threw
 * EISDIR and took initiative_status down with it, for exactly the initiatives that most
 * needed answering. */
function envelopeOf(file: string): Record<string, string> {
  if (!existsSync(file) || !statSync(file).isFile()) return {};
  return parseEnvelope(readFileSync(file, "utf8"));
}

/** Whether any source in this initiative declares that it supports `docName`.
 *
 *  Separate from `sourceReport` below, which answers a different question — which sources
 *  landed AFTER an approval — and is computed too late in this function to decide a next move.
 *  Both read the same `supports` field the same way. */
function sourcesSupport(dir: string, docName: string): boolean {
  const srcDir = join(dir, "sources");
  if (!existsSync(srcDir)) return false;
  for (const f of readdirSync(srcDir)) {
    if (!f.endsWith(".md")) continue;
    const supports = parseEnvelope(readFileSync(join(srcDir, f), "utf8")).supports || "";
    if (supports.split(",").map((x) => x.trim()).includes(docName)) return true;
  }
  return false;
}

/** The initiative's registered sources, and which of them landed after the document they
 *  support was approved.
 *
 * A FUNCTION, and reached from BOTH returns of initiativeState. This was written inline on
 * the governed path only, so a freeform initiative reported neither `sources` nor
 * `sources_after_approval` — ever — while `source_add` tells the caller in its own
 * description that "initiative_status reports this under sources_after_approval". Freeform is
 * the shape where a source is most likely to be the only structure there is.
 *
 * Compares FILE TIMES, not the dates people type: `approved_at` is day-granular and
 * hand-written, while the approval snapshot in _versions/ and the source file both carry a
 * real mtime the platform wrote itself. */
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
    // no snapshot (approved before snapshots, or written in one go) -> the
    // document's own mtime is when it last changed, approval included
    return latest || (existsSync(join(dir, docName)) ? statSync(join(dir, docName)).mtimeMs : 0);
  };
  const needsRefinement: Array<{ document: string; source: string; title: string }> = [];
  for (const f of sourceFiles) {
    const env = parseEnvelope(readFileSync(join(srcDir, f), "utf8"));
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

/** THE PLATFORM'S OWN CLOSING STEP, told apart from the flow's own documents.
 *
 * `deriveChain` appends it with `role: "handover"`; a flow that declares its own is matched
 * by name, because that manifest's author need not have known to write the role. Both halves
 * matter: one branch here must SKIP it (the flow is not finished by writing a handover) and
 * another must find it (the initiative is not complete until it is signed), and keying those
 * two on different tests is how they drifted apart. */
function isHandover(d: { name: string; role?: string }): boolean {
  return d.role === "handover" || d.name === "handover.md";
}

/** What state an initiative is in, and what the next move is — the one computation both
 * `initiative_status` and `initiative_open` answer from.
 *
 * Exported and taking `root` explicitly so it can be RUN over a fixture store rather than
 * read: every other statement about what this returns is a sentence somebody could write in
 * a comment. `checks/initiative-open.ts` drives it.
 *
 * `next_move` is null exactly when nothing declared a chain, and `next_move_absent` says why
 * in that case and is undefined otherwise. */
export function initiativeState(root: string, name: string, chain: Chain, docs: FlowDoc[]) {
  const dir = join(root, name);
  // NO CHAIN, SO NO NEXT MOVE — and that is an answer rather than a gap.
  //
  // A freeform initiative is one nobody drove with a flow: a folder of sources and documents
  // somebody assembled by hand. It is a first-class path, not a degraded one. Every document
  // operation works, every gate still gates — a gate is a person saying yes and the platform
  // stamping it, not a manifest — and the close works. The single thing it gives up is this
  // field, because there is no declared chain to read a next stage off, and inventing one
  // would be the platform guessing at a shape nobody agreed to.
  //
  // chain.ts:74-81 words the same rule for the chain itself: "Enforcing nothing is the honest
  // outcome of not knowing; enforcing somebody else's chain is a guardrail pointed at the
  // wrong thing." `next_move: null` is that sentence applied to the answer instead of to the
  // enforcement.
  //
  // WHAT THIS REPLACED, and why the replacement is not a loss. It answered
  // `action: "declare_flow"` and told the caller to pass `flow:` to document_write on the
  // first document. Both halves are now wrong: the flow is declared to `initiative_open`, at
  // the one moment the choice is meaningful, and there is no way to adopt one afterwards
  // (FR-30) — so a next move instructing somebody to do it later pointed at a door that no
  // longer opens. A freeform initiative is not waiting on anybody.
  //
  // THE TEST IS THE EMPTY CHAIN, not the missing name. It was `!chain.name && !docs.length`,
  // and a named chain with no documents slipped past it into the walk below: every branch
  // there reads `states`, which is empty, so `pending` and `awaiting` are both undefined and
  // the fallthrough answered `action: "close", document: ""` — the platform telling an agent
  // to close an initiative naming no document, off a flow that declares none. chain.ts no
  // longer produces such a chain, and this is the second half of the same fix: with nothing
  // declared there is nothing to compute a next move over, whatever resolved the chain.
  // `chain.name` is therefore null whenever this fires, which is what makes `flow: null`
  // below still the truth rather than a guess.
  if (docs.length === 0) {
    const files = existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("_")).sort()
      : [];
    // A CLOSED FREEFORM INITIATIVE IS CLOSED. There is no manifest naming a closing document,
    // so the outcome is read off whichever document carries one — which is exactly how
    // initiative_close chose where to write it. Reporting `null` here would have made every
    // freeform close invisible: the no-argument listing filters on `next_move.action ===
    // "closed"`, so a freeform initiative would have been listed as open for good.
    const envs: Array<{ name: string } & Record<string, string>> =
      files.map((f) => ({ name: f, ...envelopeOf(join(dir, f)) }));
    const closer = envs.find((e) => e.outcome);
    // AN EMPTY INITIATIVE THAT WAS ABANDONED IS OVER, and nothing above can see that.
    //
    // Every branch here reads an outcome off a DOCUMENT, and the one case with no document is
    // the one this has to answer for: an initiative opened by mistake. initiative_close records
    // that on `_open.json`, so this reads it from the same place. Without this the abandon
    // would be written and the listing would go on reporting the initiative as open, which is
    // the whole defect wearing a different hat.
    const rec = openRecord(root, name);
    if (!closer && rec?.abandoned_at) {
      return {
        initiative: name, flow: rec.flow, documents: envs, sources: 0,
        sources_after_approval: [],
        outcome: OUTCOME_STOPPED, closed_by: rec.abandoned_by ?? null,
        next_move: { action: "closed", waiting_on: "nobody",
                     why: `abandoned on ${rec.abandoned_at} — it holds no document, so the ` +
                          "outcome is recorded on its own open record and no ledger row was " +
                          "appended" },
      };
    }
    // THE SAME TWO SOURCE FIELDS THE GOVERNED RETURN CARRIES. Freeform has no manifest; it
    // still has a `sources/` directory, `source_add` still writes into it, and
    // `document_revise` still refuses a revision that cites nothing — so an agent here met
    // the owed-sources rule as an unexplained refusal instead of as reported state.
    const freeSources = sourceReport(dir, (d) => envs.find((e) => e.name === d)?.status ?? null);
    return {
      initiative: name,
      flow: null,
      documents: envs,
      sources: freeSources.sourceFiles.length,
      sources_after_approval: freeSources.needsRefinement,
      outcome: closer?.outcome ?? null,
      closed_by: closer?.closed_by ?? null,
      next_move: closer
        // The one next move a freeform initiative HAS: it is over. Not computed from a chain
        // — there is none — but read off the outcome that is already written down, so the
        // listing can stop reporting it as open without the platform inventing a stage.
        ? { action: "closed", waiting_on: "nobody",
            why: `closed with outcome: ${closer.outcome}` }
        : null,
      // STATED, not left to be inferred from the null. A caller that reads `next_move: null`
      // and nothing else cannot tell "freeform, and that is fine" from "the platform failed
      // to compute one", and those want opposite reactions.
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
  const states: DocState[] = docs.map((d) => {
    const env = envelopeOf(join(dir, d.name));
    return {
      name: d.name, role: d.role, exists: existsSync(join(dir, d.name)),
      status: env.status ?? null, gate: !!d.gate,
      approved_by: env.approved_by || undefined, approved_at: env.approved_at || undefined,
      requires: d.requires,
      sections: d.sections?.length ? d.sections : undefined,
    };
  });
  // THE CLOSE IS WHEREVER initiative_close WROTE IT. The closing document is today's
  // manifest's, and a flow can move its close — sdlc-flow closed on spec.md before review.md —
  // so an initiative closed back then carries its outcome on the older closing document, and
  // reading only today's reported it open forever. Only initiative_close writes an outcome.
  const closingEnv = ((): Record<string, string> => {
    const today = envelopeOf(join(dir, chain.closingDoc));
    if (today.outcome || !existsSync(dir)) return today;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".md") && !x.startsWith("_")).sort()) {
      const env = envelopeOf(join(dir, f));
      if (env.outcome) return env;
    }
    return today;
  })();
  const outcome = closingEnv.outcome || null;
  // WHO recorded the close, beside WHAT it was. Both are on the closing document's envelope
  // and both are stamped by initiative_close(), and reporting one without the other left the smoke
  // suite's per-lane attribution reading a field nothing emitted: it scanned each DOCUMENT
  // for `closed_by`, and DocState has never carried one. Every lane in a parallel round then
  // saw every close as its own, which is the false green that attribution exists to stop —
  // with five lanes, the first scenario to finish passed the other four.
  const closedBy = closingEnv.closed_by || null;

  // the next move, in the flow's own declared order
  let next: { action: string; document?: string; waiting_on: string; why: string };
  if (outcome) {
    // THE PLATFORM APPENDS THE HANDOVER TO EVERY FLOW, whatever the flow declares.
    //
    // Delivery ends at close; the cycle does not. What made this run expensive — the
    // question that cost a round, how this stakeholder decides, the block that behaved
    // differently from its documentation — is worth more than the deliverable to the
    // initiative after it, and it is gone the moment the conversation ends.
    //
    // Which is why it cannot be the flow author's decision. sdlc-flow wrote itself a
    // recording stage; ops-flow's close is mechanical; a flow written next week will do
    // whatever its author thought of. "What gets captured" is exactly the class of thing
    // that must not depend on that, so the step is added HERE, below the manifest, and
    // every flow ends the same way.
    //
    // Not verified in the middle, deliberately. Execute and review happen in the caller's
    // own terminal where the platform can see nothing, and a gate that pretends to check
    // what it cannot is worse than no gate: it gets satisfied, and leaves a compliant
    // record of nothing. The end of the cycle is the one point the platform does see.
    // THE HANDOVER IS A KNOWLEDGE NODE, not a document. This asked for `learnings.md`, a
    // file written into the initiative folder and then promoted into the knowledge base by
    // a second skill. The promotion step never ran once in any initiative, so the handover
    // was satisfied by writing a file nothing ever read — a compliant record of nothing,
    // which is exactly what the comment above warns a gate must not become.
    //
    // So the completion signal is the document's OWN approval, not a count derived from
    // it. Zero knowledge nodes is a legitimate outcome of a careful handover (an
    // initiative can teach the team nothing new), so a count can never distinguish that
    // from a handover nobody wrote — which is why the signal moved onto handover.md
    // itself, gated like every other document deriveChain appends. Read through the same
    // `states` machinery every other gated document already goes through here, not a
    // second bespoke path.
    // BY ROLE, and a flow that has no handover at all is CLOSED rather than stuck.
    //
    // `deriveChain` appends handover.md only to a flow that gates something, so a flow
    // gating nothing reached here with no such document, `handoverState` undefined, and the
    // first branch below telling the agent forever to write a document `document_approve`
    // would then refuse as undeclared. Nothing on this platform is that shape today, which
    // is the only reason it has not been hit — a closed initiative on such a flow would
    // never have been counted as closed.
    // A CLOSED INITIATIVE OWES NOTHING. The close is the terminal act, whatever it closed on.
    //
    // This used to hold an initiative open until handover.md was written AND approved AND its
    // promised team-node count was met -- three further gates after the close, reported as
    // `action: "handover"`. Two things were wrong with it, and the second is the one that
    // decided this.
    //
    // IT INSTRUCTED AN ACT ITS OWN GATE REFUSED. handover.md requires the flow's closing
    // document. An initiative abandoned at the plan stage has none and never will -- which
    // initiative_close already knows, recording the outcome on the furthest document the work
    // reached -- so `document_write` turned the handover away while this told the agent to
    // write it, forever. The same shape as the close-with-no-documents trap fixed in 0.54.1,
    // one document further along.
    //
    // AND WORK STOPS. Not every initiative finishes, and an initiative closed halfway is closed
    // rather than short of something: the ledger row already records what happened, and a
    // platform that goes on asking for more is asking about work nobody is doing. Closing is
    // allowed at any point, and after it the remainder is not owed.
    //
    // THE HANDOVER IS STILL WRITEABLE AND STILL WORTH WRITING -- the guard in guards.ts lets a
    // closed initiative satisfy a prerequisite its close skipped, so anybody who wants to write
    // one can, and an abandoned initiative on this platform produced the most durable node in
    // the store. What changed is only that it is no longer owed, and therefore no longer a
    // reason to report a closed initiative as open.
    next = { action: "closed", waiting_on: "nobody",
             why: `closed with outcome: ${outcome}. Nothing further is owed — the ledger row is ` +
                  "the record. If the cycle taught something worth keeping, `skill_read" +
                  "(\"zz-handover\")` mints it and writes handover.md; the close satisfies that " +
                  "document's prerequisite." };
  } else {
    // A REQUIREMENT IS MET BY THE ONLY THING ITS TARGET CAN OFFER.
    //
    // This asked for `status === "approved"` whatever the target was, and nothing ever
    // approves a NON-GATED document — `gate: false` means no approval is required, so its
    // status stays `draft` for the life of the initiative. A document requiring one could
    // therefore never become pending, `awaiting` only fires for a document that already
    // EXISTS, and both fell through to the close branch.
    //
    // sdlc-flow is exactly that shape: explore.md (no gate) -> spec.md (gate, closing) ->
    // plan.md (gate). From the moment explore.md was written, this answered
    //
    //     action: close   "every declared document exists and every gate is recorded"
    //
    // with two of the three documents absent and both of them gates. The sentence reads as
    // permission — the comment in that branch already records it causing one false close,
    // and the fix then was to reword the sentence rather than correct the condition.
    //
    // ops-flow never met it because every one of ITS requires-targets is itself gated, which
    // is why this survived: the flow that hits it is the one nobody ran end to end.
    const requirementMet = (docName: string): boolean => {
      const t = states.find((x) => x.name === docName);
      if (!t) return false;
      return t.gate ? t.status === "approved" : t.exists;
    };
    // THE HANDOVER IS NOT ONE OF THE FLOW'S DOCUMENTS, and this branch is the flow.
    //
    // `deriveChain` appends handover.md to every gating flow and gives it `requires: <the
    // closing document>` — which is satisfied the moment that document's gate is recorded.
    // So `pending` selected it BEFORE the close was ever considered, and because
    // `closeRequires` is a subset of the declared documents, the `missing` branch below
    // could not be reached either: for every gating flow on this platform,
    // `action: "close"` was unreachable and the answer after an approved review.md was
    // "write handover.md". An agent that obeyed wrote a handover about an initiative that
    // had not closed, then had the close refused until somebody approved it — while
    // zz-handover's own first line requires the outcome to exist already.
    //
    // Excluded by ROLE, not by name: `deriveChain` stamps `role: "handover"`, and a flow
    // that declares its own handover document gets the same treatment. The closed branch
    // above owns this document entirely — it is the only place that can know the outcome
    // it reports on.
    const flowDocs = states.filter((d) => !isHandover(d));
    const pending = flowDocs.find((d) => !d.exists && (!d.requires || requirementMet(d.requires)));
    const awaiting = flowDocs.find((d) => d.exists && d.gate && d.status !== "approved");
    // A STAGE THAT PRODUCES A SOURCE IS A STAGE, and this walked only the documents.
    //
    // sdlc-flow declares seven stages and four documents. The three that produce no document
    // are `sdlc-execute` (produces nothing) and the two AUDIT rounds, which evidence
    // themselves with a SOURCE supporting the document they audited rather than a document of
    // their own. Walking `states` — which is built from the manifest's `documents` — cannot
    // see them, so this answered "write plan.md" the moment spec.md was approved and never
    // once mentioned the spec audit.
    //
    // THE CLOSE DOES NOT AGREE, AND THE CLOSE IS THE ONE THAT REFUSES. The reviewed module
    // governing this flow asks each audit step for `1x audit`, so an agent that followed this
    // answer faithfully through every document reached `initiative_close` and was refused for
    // a round nothing had ever told it to run. Two authorities over one flow, and the one the
    // platform tells an agent to trust — "what comes next is computed, never guessed; ask it
    // rather than reasoning about the folder" — was the one that did not know.
    //
    // Found by driving this flow end to end on this deployment: spec.md approved,
    // `next_move` answered `write_document plan.md`, and the flow's own manifest has
    // `sdlc-spec-audit` between them.
    //
    // READ FROM THE MANIFEST'S STAGES, in their declared order, so a flow that adds or renames
    // an audit is followed without an edit here — the same rule `enrolment.ts` follows for the
    // evidence side, which is what keeps the two answers about one flow from disagreeing again.
    const audits = (chain.stages ?? [])
      .filter((st): st is Extract<typeof st, { produces: "source" }> => st.produces === "source")
      .map((st) => ({ stage: st.name ?? "", document: st.supports }))
      .filter((a) => Boolean(a.document))
      // Only once the audited document is actually finished: an audit of a document nobody
      // has agreed to audits a draft, and the document's own stage is unmet first anyway.
      .filter((a) => requirementMet(a.document))
      .filter((a) => !sourcesSupport(dir, a.document));
    // BEFORE THE NEXT DOCUMENT, NOT AFTER IT. The audit sits between two document stages in
    // the manifest, and reporting it only once every document existed would be telling the
    // agent to audit a spec it had already planned and built from.
    const owedAudit = audits[0];
    if (awaiting) {
      next = {
        action: "await_approval", document: awaiting.name, waiting_on: "stakeholder",
        why: `${awaiting.name} is ${awaiting.status ?? "unwritten"}; call document_approve("${name}/${awaiting.name}") ` +
             "once the stakeholder agrees — nothing downstream may be written until that gate is recorded",
      };
    } else if (owedAudit) {
      next = {
        // NOT A TOOL: `add_source` is a member of `next_move.action`'s own vocabulary —
        // declare_flow, write_document, await_approval, add_source, handover, closed, close —
        // the same verb_noun shape as `write_document`, which is also not a tool name. The
        // tool to call is `source_add`, and the `why` beside it says so.
        action: "add_source", document: owedAudit.document, waiting_on: "agent",
        why: `${owedAudit.stage} is the next stage this flow declares, and it evidences itself ` +
             `with a source rather than a document — run the round, then call ` +
             `source_add(initiative, title, content, supports: ["${owedAudit.document}"]). ` +
             "The close is refused until it exists",
      };
    } else if (pending) {
      next = { action: "write_document", document: pending.name, waiting_on: "agent",
               why: `${pending.name} is the next document this flow declares` };
    } else {
      const missing = chain.closeRequires.filter((n) => !existsSync(join(dir, n)));
      next = missing.length
        ? { action: "write_document", document: missing[0], waiting_on: "agent",
            why: `${missing[0]} is required before this initiative can close` }
        // NOT A TOOL: `next_move.action` is its own vocabulary — declare_flow,
        // write_document, await_approval, handover, closed, close — and `write_document`
        // is already not a tool name. Renaming one member of that set to the tool it
        // suggests would leave the set half verbs and half tool names, which is harder to
        // read than either. The `why` beside it names the tool to call.
        : { action: "close", document: chain.closingDoc, waiting_on: "agent",
            // What this said, and only this, was "every declared document exists and
            // every gate is recorded" — which reads as permission. The first live smoke
            // run reached exactly here and closed the initiative as accepted while the
            // stakeholder had accepted nothing. Every gate being recorded is a statement
            // about approvals; acceptance is a different act by a different person, and
            // the close is where the two get confused.
            why: "every declared document exists and every gate is recorded — close it " +
                 `with initiative_close("${name}", "finished") once somebody has accepted, naming ` +
                 "them in `accepted_by`. The outcome is DERIVED from that: with an " +
                 "acceptor it is `accepted`; without one it is `delivered` and owes one " +
                 "line on why nobody signed off. You do not write `outcome`, and the " +
                 "platform refuses it by hand. If nobody has accepted yet, that is what " +
                 "is outstanding, not this call" };
    }
  }
  const { sourceFiles, needsRefinement } =
    sourceReport(dir, (d) => states.find((x) => x.name === d)?.status ?? null);
  return { initiative: name,
           // The chain already knows which flow governs this initiative — it was
           // resolved to build `docs`. Reading the envelope of the FIRST DECLARED
           // document instead reported null whenever that document had not been written
           // yet, so an initiative could list a flow's documents, each with its role,
           // under "flow": null.
           flow: chain.name ?? (envelopeOf(join(dir, docs[0]?.name ?? "")).flow || null),
           documents: states, outcome, closed_by: closedBy, sources: sourceFiles.length,
           // reported, never enforced: material that landed after an
           // approval MAY warrant a revision — the team decides, and
           // document_revise is how they do it
           sources_after_approval: needsRefinement, next_move: next,
           // Undefined rather than absent, so the two returns of this function have one
           // shape and a caller can read the field without knowing which branch answered.
           next_move_absent: undefined as string | undefined };
}

export function registerInitiativeStatusTools(server: McpServer): void {
  // ── the initiative is the unit of work, not the chat ────────────────────
  // Anyone, on any harness, must be able to pick an initiative up exactly
  // where it was left. Inferring that from prose is how two harnesses reach
  // two different answers; this computes it from the manifest and the
  // frontmatter, mechanically.


  server.registerTool(
    "initiative_status",
    {
      description:
        "Where an initiative stands and WHAT THE NEXT MOVE IS, computed from the flow's manifest " +
        "and the documents' frontmatter — not from memory or from this conversation. Call it " +
        "before continuing any existing work, especially work someone started elsewhere (another " +
        "chat, Claude Code, Codex, Hermes): the initiative is the unit of work, and this is the " +
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
        // Dot-entries are not initiatives, and since the store became a git repository there
        // is one sitting in every root. walk() was taught this and this listing was not, so
        // the no-argument call — the one zz-platform tells every agent to make before
        // continuing any work — answered with `.git` as an open initiative whose next move
        // was to write the flow's first document into it.
        : readdirSync(root).filter((n) => !n.startsWith("_") && !n.startsWith(".") &&
            !n.endsWith(".md") && statSync(join(root, n)).isDirectory());
      const out = [];
      // The no-argument call promises OPEN initiatives — its own description says so and so
      // does zz-platform, which is where every agent reads about it. It returned all of
      // them: on this store that is eight, seven of them closed, so the answer to "what is
      // open" was one useful line in eight. Closed ones are counted rather than dropped,
      // because a listing that quietly omits things is the other half of the same problem.
      let closedCount = 0;
      for (const name of names) {
        if (!existsSync(join(root, name))) {
          out.push({ initiative: name, error: "no such initiative" });
          continue;
        }
        const chain = chainFor(root, `${name}/x.md`);
        const state = initiativeState(root, name, chain, chain.documents);
        // OPTIONAL-CHAINED, because `next_move` is null for a freeform initiative. Indexing
        // it bare threw here, in the no-argument listing — the one call zz-platform tells
        // every agent to make before continuing any work — so one freeform folder in the
        // store would have taken down the listing of every other initiative beside it.
        if (!initiative && state.next_move?.action === "closed") { closedCount++; continue; }
        out.push(state);
      }
      logActivity(root, null, { user: who.email, action: "initiative_status", initiative: initiative ?? "*" });
      return text(JSON.stringify(
        initiative ? out[0] : { open: out, closed_not_listed: closedCount }, null, 2));
    },
  );

  server.registerTool(
    "knowledge_reconcile",
    {
      description:
        "Put what a stage PREDICTED next to what actually happened. Every stage already writes " +
        "its commitments down — the fit ledger keyed by acceptance criterion, the criteria " +
        "themselves and who verifies each — and the gateway already records what every tool " +
        "call did. Neither exists for this; reconciling only joins them. " +
        "Ask by `initiative`. THE RIGHT-HAND SIDE IS GONE and this says so rather than " +
        "implying it: what a claim was about used to be `zz.decision.blocks`, joined to " +
        "`zz.event.block` — and 0 of 541 claims ever carried one, so the \"what happened\" half " +
        "has been empty for its whole life. Both columns are dropped. This returns the claims " +
        "a stage recorded; nothing joins them to telemetry until something records which " +
        "plugin a claim is about.",
      inputSchema: {
        initiative: z.string().min(1).describe("Reconcile this one initiative."),
      },
    },
    async ({ initiative }) => {
      const p = db();
      if (!p) return text("ERROR: no platform database — reconciliation reads zz.decision and zz.event");

      const who = parseCaller(requestHeaders());
      const team = await teamFor(who.email);
      if (!team) return text("ERROR: no team — reconciliation is scoped to the team that made the predictions");
      if (initiative) {
        const bad = safeName(initiative, "initiative");
        if (bad) return text(bad);
      }
      // The left half: what was claimed. Rows are derived at index time from text the flow
      // already wrote, so this reads the flow's own words rather than a second record of them.
      const where = initiative
        ? "d.team_slug = $1 and d.initiative = $2"
        : "d.team_slug = $1 and $2 = any(d.blocks)";
      const { rows: claims } = await p.query<{
        initiative: string; path: string; role: string; key: string;
        verdict: string; qualifier: string; detail: string; checker: string; blocks: string[];
      }>(
        `select initiative, path, role, key, verdict, qualifier, detail, checker
           from zz.decision d where ${where}
          order by initiative, path, key`,
        [team, initiative]);
      if (!claims.length) {
        return text(`No claims recorded for ${initiative}. A stage records them by writing its fit ledger or its acceptance criteria; nothing to reconcile until one has.`);
      }

      // THE RIGHT HALF IS GONE, and it never worked. It joined `zz.decision.blocks` — which
      // plugin a claim was about — to `zz.event.block`, and 0 of 541 claims on this deployment
      // ever carried one, so it reported "predictions about nothing" for every row it had. Both
      // columns are dropped by migration 057. Nothing records which plugin a claim concerns, so
      // there is nothing to join to; saying so is better than a join that returns zeroes and
      // reads as evidence that nothing went wrong.
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
        note: "What a stage PREDICTED, in the flow's own words. There is no right-hand side: " +
              "nothing records which plugin a claim is about, so nothing joins these to what " +
              "actually happened. A claim listed here has not been checked against anything.",
        claims_recorded: out,
      }, null, 2));
    },
  );
}
