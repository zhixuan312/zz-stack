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
import { factsFor, openRecord } from "../initiative-record.js";
import { chainFor } from "../chain.js";
import { safeName, userRoot } from "../paths.js";
import { logActivity } from "../persist.js";
import { db, teamFor } from "../platform-db.js";
import { type Chain } from "../write-guards.js";

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
 * in that case and is undefined otherwise. */
export function initiativeState(root: string, name: string, chain: Chain, docs: FlowDoc[]) {
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
    // envelope to read an outcome off.
    // COUPLED: initiative_close records abandoned_at/abandoned_by on `_open.json`.
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
    // The same two source fields the governed return carries: freeform has no manifest but
    // still has a `sources/` directory, `source_add` still writes into it, and
    // `document_revise` still refuses a revision that cites nothing.
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
  const appliesOf = (docName: string): Applicability => {
    const spec = docs.find((d) => d.name === docName);
    return spec?.when ? documentApplies(spec, facts) : "applies";
  };
  const states: DocState[] = docs.map((d) => {
    const env = envelopeOf(join(dir, d.name));
    return {
      name: d.name, role: d.role, exists: existsSync(join(dir, d.name)),
      status: env.status ?? null, gate: !!d.gate,
      approved_by: env.approved_by || undefined, approved_at: env.approved_at || undefined,
      requires: d.requires,
      sections: d.sections?.length ? d.sections : undefined,
      applies: d.when ? documentApplies(d, facts) : undefined,
    };
  });
  // The close is wherever initiative_close wrote it. A flow can move its closing document, so
  // an initiative closed earlier carries its outcome on a document today's manifest does not
  // name. Only initiative_close writes an outcome.
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
  // Who recorded the close, beside what it was. Both sit on the closing document's envelope,
  // stamped by initiative_close(). DocState carries no `closed_by`.
  const closedBy = closingEnv.closed_by || null;

  // the next move, in the flow's own declared order
  let next: { action: string; document?: string; waiting_on: string; why: string };
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
    if (awaiting) {
      next = {
        action: "await_approval", document: awaiting.name, waiting_on: "stakeholder",
        why: `${awaiting.name} is ${awaiting.status ?? "unwritten"}; call document_approve("${name}/${awaiting.name}") ` +
             "once the stakeholder agrees — nothing downstream may be written until that gate is recorded",
      };
    } else if (owedAudit) {
      // NOT A TOOL: `add_source` and `decide` are members of `next_move.action`'s own
      // vocabulary, not tool names. The `why` beside each names the call to make.
      next = owedAudit;
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
        // write_document, await_approval, add_source, decide, resolve_branch, handover, closed,
        // close — not tool names. The `why` beside it names the tool to call.
        //
        // FR-58 (Task I-28): `chain.closingDoc` is a static, per-flow answer, and a
        // `when`-conditional closing document (`improvement.md`, promotable only) is
        // `not_applicable` on every other branch — the same question `initiative_close`
        // (initiative-close.ts) and `closeCheck` (guards.ts) both ask before deciding where a
        // close actually lands, asked here too so this call never names a document those two
        // would refuse to close on. `flowDocs` is already filtered to what applies on this
        // branch and, by construction of this `else` arm, every one of them exists — so its
        // last entry IS the furthest document this branch actually wrote.
        : { action: "close",
            document: chain.closingDoc && appliesOf(chain.closingDoc) === "not_applicable"
              ? flowDocs[flowDocs.length - 1]?.name ?? chain.closingDoc
              : chain.closingDoc,
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
  const { sourceFiles, needsRefinement } =
    sourceReport(dir, (d) => states.find((x) => x.name === d)?.status ?? null);
  return { initiative: name,
           // The chain already knows which flow governs this initiative — it was resolved
           // to build `docs`. The envelope fallback answers only when it does not.
           flow: chain.name ?? (envelopeOf(join(dir, docs[0]?.name ?? "")).flow || null),
           documents: states, outcome, closed_by: closedBy, sources: sourceFiles.length,
           // reported, never enforced: material that landed after an approval may warrant
           // a revision — the team decides, and document_revise is how they do it
           sources_after_approval: needsRefinement, next_move: next,
           // Undefined rather than absent, so the two returns of this function have one
           // shape and a caller can read the field without knowing which branch answered.
           next_move_absent: undefined as string | undefined };
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
      const out = [];
      // The no-argument call promises open initiatives. Closed ones are counted rather than
      // dropped, so a filtered answer is not mistaken for an empty one.
      let closedCount = 0;
      for (const name of names) {
        if (!existsSync(join(root, name))) {
          out.push({ initiative: name, error: "no such initiative" });
          continue;
        }
        const chain = chainFor(root, `${name}/x.md`);
        const state = initiativeState(root, name, chain, chain.documents);
        // DELIBERATE: optional-chained — `next_move` is null for a freeform initiative, and
        // one such folder would otherwise take down the listing of every initiative beside
        // it.
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
