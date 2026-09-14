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
import { parseCaller, parseEnvelope, type FlowDoc } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

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
    return {
      initiative: name,
      flow: null,
      documents: envs,
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
  const closingEnv = envelopeOf(join(dir, chain.closingDoc));
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
    const handoverState = states.find((d) => d.name === "handover.md");
    next = !handoverState || !handoverState.exists
      ? {
          action: "handover", waiting_on: "agent",
          why: `closed with outcome: ${outcome}; the platform's closing step is the ` +
               "handover — run `skill_read(\"zz-handover\")`, mint what generalises with " +
               "`knowledge_add`, and write handover.md, so what this cycle learned " +
               "outlives the conversation that learned it",
        }
      : handoverState.status !== "approved"
      ? {
          action: "handover", waiting_on: "human",
          why: `closed with outcome: ${outcome}; handover.md is ` +
               `${handoverState.status ?? "unwritten"} — call ` +
               `document_approve("${name}/handover.md") once the stakeholder agrees before this ` +
               "initiative can close",
        }
      : (() => {
          // THE APPROVAL AUTHORISES THE TEAM NODES; IT DOES NOT WRITE THEM.
          //
          // zz-handover mints platform nodes immediately and PROPOSES team nodes in
          // handover.md, minting them only once a team member has approved. But document_approve()
          // is a generic gate recorder with no side effect, so nothing makes that second
          // pass happen. Reading "closed" the moment the document was approved therefore
          // let an initiative report complete with every promised team node unwritten, and
          // nothing anywhere noticed — a promise recorded whose keeping went unverified,
          // which is the same shape as the substring scan this branch replaced.
          //
          // So the document declares how many it promised, and the count has to be met.
          // This is NOT the deleted substring scan returning: that read every node's whole text
          // for the initiative's name and any mention satisfied it. This reads a number the
          // document itself states, and counts nodes on the TEAM shelf whose structured
          // `evidence` names this initiative. A promise of zero is met by zero, so a
          // careful handover that found nothing worth the team keeping still closes — the
          // rule is "keep what you promised", never "promise something".
          const promised = Number(
            parseEnvelope(readFileSync(join(root, name, "handover.md"), "utf8"))
              .proposed_team_nodes ?? "0");
          if (!promised) {
            return { action: "closed", waiting_on: "nobody",
                     why: `closed with outcome: ${outcome}; handover.md is approved` };
          }
          const ndir = join(root, "_knowledge", "nodes");
          const minted = existsSync(ndir)
            ? readdirSync(ndir).filter((f) => f.endsWith(".md")).filter((f) => {
                // Through parseEnvelope like every other envelope read on this platform.
                // A bespoke regex here would take the first match rather than the last of a
                // repeated key, and would read the whole document rather than the
                // frontmatter — the two failures that rule exists for.
                const ev = parseEnvelope(readFileSync(join(ndir, f), "utf8")).evidence ?? "";
                return ev.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).includes(name);
              }).length
            : 0;
          return minted >= promised
            ? { action: "closed", waiting_on: "nobody",
                why: `closed with outcome: ${outcome}; handover.md is approved and its ` +
                     `${promised} proposed team node(s) are written` }
            : { action: "handover", waiting_on: "agent",
                why: `closed with outcome: ${outcome}; handover.md is approved but only ` +
                     `${minted} of the ${promised} team node(s) it proposed have been ` +
                     "written — run `skill_read(\"zz-handover\")` and mint the rest with " +
                     "`knowledge_add(scope: \"team\")`, exactly as the approved document " +
                     "promised them" };
        })();
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
    const pending = states.find((d) => !d.exists && (!d.requires || requirementMet(d.requires)));
    const awaiting = states.find((d) => d.exists && d.gate && d.status !== "approved");
    if (awaiting) {
      next = {
        action: "await_approval", document: awaiting.name, waiting_on: "stakeholder",
        why: `${awaiting.name} is ${awaiting.status ?? "unwritten"}; call document_approve("${name}/${awaiting.name}") ` +
             "once the stakeholder agrees — nothing downstream may be written until that gate is recorded",
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
  // A source attached AFTER a document was approved means that document may
  // no longer say what the team knows. Compare FILE TIMES, not the dates
  // people type: `approved_at` is day-granular and hand-written, while the
  // approval snapshot in _versions/ and the source file both carry a real
  // mtime the platform wrote itself.
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
      const st = states.find((x) => x.name === d);
      if (!st || st.status !== "approved") continue;
      if (sourceTime > approvalTime(d)) {
        needsRefinement.push({ document: d, source: `sources/${f}`, title: env.title || f });
      }
    }
  }
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
      const team = await teamFor(who.email);
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
        const chain = await chainFor(root, `${name}/x.md`, team);
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
        "Ask by `initiative` to review one, or by `block` to ask what this team has predicted " +
        "about a block across everything it has run. Those are the two questions, and there " +
        "is no third.",
      inputSchema: {
        initiative: z.string().optional().describe("Reconcile this one initiative."),
        block: z.string().optional().describe("Ask what was predicted about this block, everywhere."),
      },
    },
    async ({ initiative, block }) => {
      const p = db();
      if (!p) return text("ERROR: no platform database — reconciliation reads zz.decision and zz.event");
      if (!initiative && !block) {
        return text("ERROR: ask by `initiative` (review this one) or by `block` (what have we predicted about it). Those are the two questions.");
      }
      // ASKING BOTH QUESTIONS AT ONCE ANSWERS NEITHER.
      //
      // The precedence below is a ternary, not a `??` — once `initiative` is truthy, `block`
      // is never referenced again. Supplying both used to silently reconcile the initiative
      // and drop the block question with no trace. Refused instead, beside the
      // neither-supplied guard above.
      if (initiative && block) {
        return text(
          "ERROR: `initiative` and `block` are two different questions — one asks what this " +
          "initiative predicted, the other what this block was called for. You supplied both " +
          "(`" + initiative + "` / `" + block + "`). Ask one.");
      }
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
        `select initiative, path, role, key, verdict, qualifier, detail, checker, blocks
           from zz.decision d where ${where}
          order by initiative, path, key`,
        [team, initiative ?? block]);
      if (!claims.length) {
        return text(initiative
          ? `No claims recorded for ${initiative}. A stage records them by writing its fit ledger or its acceptance criteria; nothing to reconcile until one has.`
          : `Nothing has been predicted about '${block}' by ${team}.`);
      }

      // The right half: what the blocks those claims name actually did. `subject` is
      // `<block>:<tool>`, so splitting on the colon is the whole join. Refusals are counted
      // by the platform's own refusal text, which is the only mechanical account of WHY
      // something did not work — a status code would be blind to it, since a refusing MCP
      // tool answers 200 with `ERROR:` in its text.
      //
      // split_part, not LIKE. A block name comes from a document's `server:` line, which is
      // free text an author wrote, and `_` is a LIKE wildcard matching any single character —
      // so a block called `my_block` would have counted calls belonging to `myXblock` too.
      // An exact comparison on the part before the colon has no metacharacters to escape.
      // SCOPED TO THIS INITIATIVE'S OWN LIFETIME when one was named. Without a bound, the
      // right half was every call the team had ever made — so a fresh initiative's
      // predictions were read against every previous initiative's calls, and the more work a
      // team did the more wrong this got.
      //
      // The remedy that was in place instead was to DELETE the events between runs, which
      // made the join correct by destroying the only central evidence the improvement loop
      // has. Ten evaluation rounds ran under it and the database ended holding one of them.
      // Scoping the join is the same correctness for none of the loss.
      //
      // Asking by BLOCK is deliberately unscoped: "what have we predicted about casebox" is a
      // question about a block across all of a team's work, and bounding it to one
      // initiative would answer a different one.
      let since: string | null = null;
      if (initiative) {
        const { rows: w } = await p.query<{ started: string | null }>(
          `select min(created_at)::text as started from zz.doc
            where team_slug = $1 and initiative = $2`, [team, initiative]);
        since = w[0]?.started ?? null;
      }
      // `block`, which is where the block's name lives since zz.event got real columns. It was
      // `surface` before that, and this query kept asking for the old name for a day and a half —
      // answering `column "surface" does not exist` to every caller, 63 times in the first minute
      // and silently thereafter, because nothing calls reconcile on a schedule and a migration
      // that compiles is a migration that looks finished.
      //
      // The names on both sides of this join have to be the SAME name. zz.event carries the bare
      // `casebox`; zz.decision.blocks carried casebox spelled six ways until it was normalised at index
      // time, so this join matched about a third of the rows it should
      // have and reported the rest as predictions about nothing.
      const named = [...new Set(claims.flatMap((c) => c.blocks ?? []))].filter(Boolean);
      const actual = new Map<string, { calls: number; refused: number; top: string | null }>();
      for (const b of named) {
        const { rows } = await p.query<{ calls: string; refused: string; top: string | null }>(
          `select count(*)::text as calls,
                  count(*) filter (where ok is false)::text as refused,
                  (select refusal from zz.event
                    where kind = 'tool_call' and team_slug = $1 and block = $2 and refusal is not null
                      and ($3::timestamptz is null or ts >= $3::timestamptz)
                    group by refusal order by count(*) desc limit 1) as top
             from zz.event
            where kind = 'tool_call' and team_slug = $1 and block = $2
              and ($3::timestamptz is null or ts >= $3::timestamptz)`,
          [team, b, since]);
        const r = rows[0];
        actual.set(b, { calls: Number(r?.calls ?? 0), refused: Number(r?.refused ?? 0), top: r?.top ?? null });
      }

      const out = claims.map((c) => ({
        initiative: c.initiative,
        key: c.key,
        predicted: { verdict: c.verdict, qualifier: c.qualifier || null, by: c.detail || null,
                     verified_by: c.checker || null, blocks: c.blocks ?? [] },
        happened: (c.blocks ?? []).map((b) => ({ block: b, ...(actual.get(b) ?? { calls: 0, refused: 0, top: null }) })),
      }));
      const unmet = out.filter((o) => o.happened.some((h) => h.refused > 0));
      return text(JSON.stringify({
        team,
        scope: initiative ? { initiative } : { block },
        // The window is printed, because a scoped count that does not say what it was scoped
        // to is indistinguishable from an unscoped one that happened to be small.
        counting_calls_since: since ?? "(every call this team has made — asking by block is not bounded to one initiative)",
        claims: out.length,
        claims_whose_blocks_refused: unmet.length,
        note: "A refusal count is not a verdict — it is where to look. The prediction is on the left in the flow's own words; what the blocks did is on the right.",
        reconciliation: out,
      }, null, 2));
    },
  );
}
