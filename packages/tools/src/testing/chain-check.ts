/**
 * Walk a flow's document chain with direct MCP calls — no model in the loop.
 *
 *   ZZ_GATEWAY=<gateway> ZZ_PAT=<a person's token> npm run chain-check -- [initiative]
 *
 * Without an initiative it opens a fresh one each run, because every check here assumes an
 * initiative that does not exist yet.
 *
 * WHY THIS EXISTS BESIDE smoke-engine. The smoke suite proves an AGENT can drive a flow,
 * which is the thing users actually do — and it needs a model provider for every one of its
 * hundreds of turns. When that provider rate-limits (this deployment's account did,
 * mid-round, twice), the suite cannot say whether the PLATFORM still works, because it never
 * got a turn.
 *
 * This asks the narrower question the platform is actually responsible for: are the gates
 * enforced, is the chain ordered, and does closing record itself? Those are promises zz-core
 * keeps on its own, so nothing about a model's availability should stop us checking them. It
 * runs in seconds and costs no model tokens.
 *
 * It is deliberately not part of scripts/gate.ts: the gate is offline and proves things
 * about the source, while this needs a running deployment and a real token.
 */
import { randomUUID } from "node:crypto";

import { pluginName } from "@zz/catalog";
import { parseEnvelope } from "@zz/contracts";
import { Mcp } from "@zz/mcp-client";

import { flowDeclaration } from "./flow-declaration.js";

import { RESULTS, check, eitherOr, record } from "./chain-report.js";
import { walkBugs } from "./chain-bugs.js";
import { walkEvalDoor } from "./chain-eval.js";
import { walkFreeform } from "./chain-freeform.js";
import { walkShelf } from "./chain-shelf.js";
import { die, envRequired, parseArgs } from "../lib/cli.js";

const GW = envRequired("ZZ_GATEWAY", "the gateway to walk the chain against").replace(/\/+$/, "");
const PAT = envRequired("ZZ_PAT", "a person's platform token");
/**
 * A FRESH initiative each run, unless one is named.
 *
 * This defaulted to the fixed slug `chain-check`, and every check below assumes an initiative
 * that does not exist yet: the first write opens it, the approvals are the first, the close is
 * the first. Run twice against one store, the second run writes over an approved gated
 * document — which the platform refuses, correctly — and reports the platform broken. The
 * ledger assertion at the end is explicit about it: `!before.includes(INIT)` can only be true
 * the first time.
 *
 * So the tool that exists to say "the platform still works when the model provider is down"
 * worked once per store and failed every time after, for a reason none of its output names.
 * Passing an initiative explicitly still re-enters one deliberately.
 */
function freshSlug(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `chain-check-${p(d.getDate())}${p(d.getMonth() + 1)}-${randomUUID().slice(0, 4)}`;
}
/** A SLUG, not a name. The platform composes `<YYYY-MM-DD>-<slug>` from its own clock, and
 * this probe must not compose one of its own — a date it chose would be the exact mistake
 * `initiative_open` exists to make unreachable, written by the tool that checks the door. */
const SLUG = freshSlug();
/** Filled from what `initiative_open` hands back, or from the positional argument when a run
 * deliberately re-enters an existing initiative. Declared `let` because only the platform
 * knows the name until the open returns. */
let INIT = parseArgs(process.argv.slice(2)).positional[0] ?? "";

// WHICH flow this document belongs to. A team running one flow needs no such line — the
// platform infers it. A team running two cannot: nothing else says which gates apply, and
// the write is refused, so a check that omitted this passed on a single-flow host and failed
// on a real one.
//
// The default was `ops-flow`, a flow this catalog no longer has — so the unconfigured run
// declared a flow the platform would refuse by name, and the check failed for a reason that
// had nothing to do with what it tests.
const FLOW = (process.env.CHAIN_FLOW || "sdlc-flow").trim();

const DECLARED = flowDeclaration(FLOW)
  ?? die(`no catalog manifest for flow '${FLOW}' — set CHAIN_FLOW to a flow this checkout declares`);
const FLOW_STAGES = DECLARED.sourceStages;
const DOCUMENTS = DECLARED.documents;
const OPENS_ON = DOCUMENTS[0].name;
/** THE FIRST GATED DOCUMENT, which is where every approval rule can be exercised.
 *
 * The document a flow OPENS on is not necessarily gated — sdlc-flow opens on explore.md, which
 * carries none — and since 0.44 the platform stamps `status` only where the manifest declares a
 * gate and `document_approve` refuses a document that carries none. So the approval walk below
 * runs on this one; the opening document is what proves the ungated half. */
const FIRST_GATED = (DOCUMENTS.find((d) => d.gate === true) ?? DOCUMENTS[0]).name;

/** THE HEADINGS A DOCUMENT MUST CARRY, from the manifest that requires them.
 *
 * Written as a fixed `# chain check` and a line of prose, this probe wrote a body that
 * sdlc-flow refuses: the flow declares `sections` on explore.md, spec.md and plan.md, and
 * document_write enforces them. So the first write failed, explore.md never existed, and the
 * twenty-nine steps after it failed on a document that was never there — thirty-one failures
 * with one cause, which is how this probe reported a release that had nothing wrong with it.
 *
 * It is the same defect this file already fixed one level up. `firstDocument()` above stopped
 * hardcoding `intent.md` and read the flow's own first document; the BODY went on being a
 * constant. A probe that reads a manifest for what to write into, and not for what that
 * manifest requires, is still testing its author's memory of the flow. */
const SECTIONS = new Map<string, string[]>(
  DOCUMENTS.filter((d) => d.sections?.length).map((d) => [d.name, d.sections as string[]]));

/** Replace the catalog's answer with the PLATFORM's, once an initiative exists.
 *
 * The manifest in this checkout is not the whole rule. `chain.ts` appends the handover
 * document below every flow's own list, with sections of its own that appear in no flow.json
 * — so a probe reading only the catalog wrote a handover the platform then refused, and the
 * refusal named three headings nothing in the repository declares. initiative_status returns
 * `sections` per document precisely so a caller does not have to know which half declared
 * them. */
async function loadSectionsFromPlatform(initiative: string): Promise<void> {
  try {
    const status = JSON.parse(await call("initiative_status", { initiative })) as {
      documents?: { name: string; sections?: string[] }[];
    };
    for (const d of status.documents ?? []) {
      if (d.sections?.length) SECTIONS.set(d.name, d.sections);
    }
  } catch {
    // The catalog's answer stands. A probe that cannot read the status has bigger problems
    // than its fixtures, and the steps below will say so in their own words.
  }
}
const sectionsFor = (name: string): string[] => SECTIONS.get(name) ?? [];

/**
 * The plugin the plugin-eval tools are exercised against, below. `entryOf` on the core
 * resolves a plugin from a flow through the same `pluginName` — so this names the same catalog entry FLOW already had to resolve for `firstDocument()` to
 * succeed, rather than a second identifier this script would have to keep in sync with it.
 */
const PLUGIN = pluginName(FLOW);

const core = new Mcp(`${GW}/core/mcp`, { pat: PAT, client: "chain-check" });

/** A tool's text, refusals included — a refusal is what most checks here assert on. */
const call = (tool: string, args: unknown): Promise<string> => core.call(tool, args);

/** THE EVALUATION DOOR IS A SECOND CLIENT, not a second path on the first.
 *
 * The ten `plugin_*` tools left `/core/mcp` for `/eval/mcp` in Task I-19, and this file opened
 * exactly one client. Calling them on the core door answers "tool not found" ten times — at
 * RELEASE, because `release.ts` runs this and the offline gate deliberately does not, so
 * nothing before a release would have said so. `checks/chain-check-wiring.ts` could not catch
 * it either: it asserts every tool registered under `services/zz-core/src/tools` is exercised,
 * one direction only, so ten tools LEAVING that directory made it quieter rather than redder. */
const evalDoor = new Mcp(`${GW}/eval/mcp`, { pat: PAT, client: "chain-check" });
const callEval = (tool: string, args: unknown): Promise<string> => evalDoor.call(tool, args);

/** THE ACCESS DOOR IS A THIRD CLIENT, for the reason the evaluation door became a second one.
 *
 * `knowledge_reindex` left `/core/mcp` for `/manage/mcp` at Task I-38 — rebuilding a team's
 * index is an administrative act on a team, not a step in anybody's flow — and this file
 * opened no client that could reach it. The probe below would answer "tool not found" at
 * RELEASE, because release.ts runs this and the offline gate deliberately does not. */
const manageDoor = new Mcp(`${GW}/manage/mcp`, { pat: PAT, client: "chain-check" });

/**
 * A probe document: THE BODY, and nothing else.
 *
 * `flow` is a caller ARGUMENT — it says which flow governs the initiative, and the platform
 * stamps every other envelope field from it. This docblock has said so since document_write gained
 * that argument; the line below went on emitting `---\nflow: …\n---`, so the comment described
 * the design and the code did the thing the design replaced.
 *
 * document_write refuses content that opens with frontmatter, in as many words — "takes the
 * document's BODY — the frontmatter is written by the platform, not by hand". So EVERY write
 * in this probe was refused, and the probe that exists to say "the platform still works when
 * the model provider is down" could not complete one. It needs a live deployment, which is
 * why nothing caught it.
 */
function doc(body: string, name = ""): string {
  const wanted = sectionsFor(name);
  // Each heading gets a line of its own under it: the platform refuses a declared section
  // that is present as a heading and empty underneath, in as many words.
  const sections = wanted.map((h) => `## ${h}\n\n${body}\n`).join("\n");
  return `# chain check\n\n${body}\n${sections ? `\n${sections}` : ""}`;
}

/** A write. The flow is NOT an argument here any more — it is declared once, to
 * `initiative_open`, and `document_write` refuses one outright.
 *
 * The document's NAME reaches `doc()` so the body can carry the sections that document is
 * declared to need. `path` is `<initiative>/<name>`, and the manifest keys on the name. */
const writeDoc = (path: string, body: string): Promise<string> =>
  call("document_write", { path, content: doc(body, path.split("/").pop() ?? "") });

async function main(): Promise<number> {
  // OPENING IS ITS OWN ACT, and every write below depends on it. `document_write` refuses a
  // path whose initiative was never opened, and so does `source_add` — so a probe that walked
  // straight into a write would now fail on its first line, for a reason that has nothing to
  // do with what it is probing. The NAME comes back from the platform: it prepends today's
  // date to the slug, and this tool deliberately does not know how to build one.
  if (!INIT) {
    const body = await call("initiative_open", { slug: SLUG, flow: FLOW });
    const parsed = JSON.parse(body) as { initiative?: string };
    if (!parsed.initiative) {
      console.log(`  FAIL  initiative_open returned no name: ${body.slice(0, 300)}`);
      return 1;
    }
    INIT = parsed.initiative;
    console.log(`  ok    initiative_open("${SLUG}", "${FLOW}") -> ${INIT}`);
    // Before the first write, so every body carries what the platform will demand of it.
    await loadSectionsFromPlatform(INIT);
    // A SECOND OPEN OF THE SAME SLUG IS REFUSED, and this is the only place that can be
    // checked against a live door. Two folders for one slug diverge with nothing able to say
    // which was meant.
    check("a slug already taken is refused",
      await call("initiative_open", { slug: SLUG }), true, /already taken/);
    // AND THE OTHER DIRECTION, which is the half a null-only assertion cannot see: the
    // flow-driven initiative opened above must still be told its first document.
    const govNext = JSON.parse(
      await call("initiative_status", { initiative: INIT })) as { next_move?: { action?: string } };
    record(govNext.next_move?.action === "write_document",
      "a flow-driven initiative is told its first document",
      `governed next_move was ${JSON.stringify(govNext.next_move)}, expected write_document`);
    await walkFreeform({ call, check, record, writeDoc, SLUG, FLOW, OPENS_ON });

  }
  console.log(`walking ${INIT}/ through ${GW}`);

  // A gate is passed BY A PERSON, ON A DAY, and the platform is what knows both. This used
  // to write `status: approved` by hand and assert on the ATTRIBUTION guard — an approval
  // naming nobody, or carrying no date, was refused. That guard still stands, but a
  // hand-written approval no longer reaches it: ownershipCheck refuses the field itself, one
  // layer earlier. Asserting the old way would still have printed `ok` while testing a
  // different rule, which is the quietest way for a suite to stop measuring what it says it
  // measures.
  check("a draft needs no approver", await writeDoc(`${INIT}/${OPENS_ON}`, "intent"), false);

  // The platform authored `status` on that write. Nothing else could have: the document went
  // in without the field.
  const opened = await call("document_read", { path: `${INIT}/${OPENS_ON}` });
  // A STATUS IS A GATE VERDICT, so it exists only where the flow declares a gate. The platform
  // stamps `status: draft` on a gated document and nothing at all on an ungated one — this
  // asserted `draft` on whichever document the flow opens on, which is explore.md in sdlc-flow,
  // and had been failing against the platform working as designed since 0.44.
  const opensGated = DOCUMENTS[0].gate === true;
  record(opensGated === opened.includes("status: draft"),
         opensGated
           ? `${OPENS_ON} is gated, so it opens as a draft the platform stamped`
           : `${OPENS_ON} carries no gate, so the platform stamps it no status`,
         opened);

  // AND IT STAYS WITHOUT ONE THROUGH A REVISION, which is the writer that missed the rule.
  //
  // stampEnvelope and document_approve both learned in 0.44 that a status is a gate verdict;
  // document_revise went on putting every revision back to `draft` regardless, so revising an
  // ungated document minted the state the other two refuse. It reached real work before a
  // doctor probe caught it — on a deployment, after a release, which is the long way round.
  if (!opensGated) {
    check(`revising ${OPENS_ON} is accepted`,
      await call("document_revise", {
        path: `${INIT}/${OPENS_ON}`, content: doc("revised", OPENS_ON),
        source_content: "chain-check revised the opening document to prove an ungated one stays ungated.",
        source_title: "chain-check: revising an ungated document",
      }), false);
    const revised = await call("document_read", { path: `${INIT}/${OPENS_ON}` });
    // THROUGH parseEnvelope, which is the one reader of an envelope: a regex here would be a
    // second one, and the two disagree the first time a value repeats or a body line starts
    // with the same word.
    record(parseEnvelope(revised).status === undefined,
           `${OPENS_ON} carries no gate, so a revision leaves it no status`, revised);
  }

  // ON A DRAFT, while `status: draft` is still in the file. Run after the approve loop below
  // this found nothing to replace and passed on document_patch's arity error instead of on the
  // rule — the quietest way for a suite to stop measuring what it says it measures, which is
  // the thing this file's own comments keep warning about.
  // THE GATED DOCUMENT, written here so the approval rules below have one to run on. It is
  // written in flow order — everything it requires is already on the record.
  if (FIRST_GATED !== OPENS_ON) {
    check(`write ${FIRST_GATED}`, await writeDoc(`${INIT}/${FIRST_GATED}`, FIRST_GATED), false);
  }
  check("an approval written by hand is refused",
    await call("document_patch", { path: `${INIT}/${FIRST_GATED}`, find: "status: draft", replace: "status: approved" }),
    true, /document_patch edits the document's BODY/);

  // A GATED DRAFT IS REWRITTEN BY document_write, and the platform's own fields survive it.
  //
  // `document_write` says "create or overwrite", and the overwrite half was refused for
  // EVERY gated document: the envelope it built carried no `status`, the copy on disk
  // carried `status: draft`, and ownershipCheck read the difference as a hand removal —
  // "this write would change it from `draft` to `(removed)`. Use document_approve(path) the
  // moment the person agrees", which would have approved a document nobody had rewritten.
  // Nothing here saw it because every write in this walk was a first write.
  //
  // `version` is asserted in the same breath and for the same root cause: it is not a field
  // ownershipCheck guards, so a rewrite reset a revised document to v1 silently, and the
  // next revise then wrote a `_versions/` snapshot over one that already existed.
  check(`a gated draft is rewritten by document_write`,
    await writeDoc(`${INIT}/${FIRST_GATED}`, `${FIRST_GATED} rewritten`), false);
  const rewritten = parseEnvelope(await call("document_read", { path: `${INIT}/${FIRST_GATED}` }));
  record(rewritten.status === "draft" && (rewritten.version ?? "1") === "1",
    "a rewrite keeps the platform's own fields",
    `after the rewrite status was ${JSON.stringify(rewritten.status)} and version ` +
    `${JSON.stringify(rewritten.version)}, expected draft and 1`);

  // AN UNGATED DOCUMENT CANNOT BE APPROVED. It is finished by being written; there is no
  // verdict to record, and the platform says so rather than stamping an approval nobody gave.
  if (FIRST_GATED !== OPENS_ON) {
    check("document_approve() refuses a document its flow does not gate",
      await call("document_approve", { path: `${INIT}/${OPENS_ON}`, on_behalf_of: "Chain Check" }),
      true, /carries no gate/);
  }

  check("document_approve() records a verdict on a document that exists",
    await call("document_approve", { path: `${INIT}/${FIRST_GATED}`, on_behalf_of: "Chain Check" }), false);
  check("document_approve() refuses a document that does not",
    await call("document_approve", { path: `${INIT}/nothing-here.md` }), true,
    /does not exist|not a document this flow declares/);

  // BOTH halves, from the session rather than from the model. Read back, because the tool
  // reporting success is the tool's own account of itself.
  const signed = await call("document_read", { path: `${INIT}/${FIRST_GATED}` });
  const both = signed.includes("approved_by: Chain Check") && /approved_at: \d{4}-\d{2}-\d{2}/.test(signed);
  record(both, "document_approve() stamps an approver AND a day", signed);

  const status = JSON.parse(await call("initiative_status", { initiative: INIT })) as {
    documents: { name: string; status?: string | null; gate?: boolean }[];
    next_move?: { action?: string; document?: string };
  };
  // THE FLOW'S OWN DOCUMENTS, WITHOUT THE PLATFORM'S HANDOVER.
  //
  // `initiative_status.documents` includes the handover the platform appends to every gating
  // flow, and the handover is written AFTER the close — zz-handover's own first line requires
  // the outcome to exist already. Walking it with the rest made this probe write and approve
  // a handover for an initiative that had not closed, which is exactly the wrong sequence the
  // platform used to advise, and it hid the defect: with the handover already approved,
  // `next_move` reached the close branch and the assertion below passed while the platform
  // was telling every real agent to write a handover instead.
  const docs = status.documents.filter((d) => d.name !== "handover.md").map((d) => d.name);
  // What is ALREADY approved, from the platform's own answer. The write loop below walked
  // every document including the one approved above it — and document_write on an approved
  // document is refused by design, so the loop's first iteration failed against a platform
  // that was working exactly as documented. Skipping it is not avoiding the case: that
  // refusal is asserted directly further down.
  //
  // APPROVED, WHETHER OR NOT IT IS GATED. This filtered on `d.gate && approved`, and the
  // document this flow opens on is approved and UNGATED — so it was not skipped, the loop
  // rewrote it, and the refusal arrived in the middle of a loop that had no assertion for it.
  // The platform's rule is about the approval, not about the gate: a gate decides whether an
  // approval is REQUIRED, never whether one that exists may be overwritten.
  const settled = new Set(status.documents
    .filter((d) => d.status === "approved").map((d) => d.name));
  // The team, from the platform rather than an environment variable — the team-rejection
  // check below is only meaningful if it passes the REAL team name.
  let team = "";
  try {
    team = ((JSON.parse(await call("session_whoami", {})) as { team?: string }).team ?? "").trim();
  } catch {
    // No identity to read: the team-name check below simply asserts nothing about a team.
  }

  // Order is enforced: a document cannot be written before what it requires.
  if (docs.length > 2) {
    check("the chain cannot be skipped",
      await writeDoc(`${INIT}/${docs[docs.length - 1]}`, "early"),
      true, /the flow writes it first|approval gate has not been recorded/);
  }

  // Write each document as a DRAFT and approve it as a separate act, which is the only route
  // there is now. The opening document is written and approved above and is skipped here —
  // approving twice is not an error, because the guard tests the CHANGE and not the presence,
  // but WRITING over an approved gated document is refused, and that refusal is asserted
  // directly below rather than tripped over in the middle of a loop.
  // APPROVE WHAT THE FLOW GATES, and nothing else: `document_approve` refuses a document the
  // manifest declares without a gate, which is the rule asserted directly above.
  const gatedName = new Set(status.documents.filter((d) => d.gate === true).map((d) => d.name));
  for (const name of docs) {
    if (settled.has(name)) continue;
    check(`write ${name}`, await writeDoc(`${INIT}/${name}`, name), false);
    if (gatedName.has(name)) {
      check(`approve ${name}`, await call("document_approve", { path: `${INIT}/${name}`, on_behalf_of: "Chain Check" }), false);
    }
  }

  // And the refusal the skip above relies on, asserted rather than assumed: an approved gated
  // document does not change through document_write.
  check("an approved document does not change through document_write",
    await writeDoc(`${INIT}/${FIRST_GATED}`, "rewritten"),
    true, /document_revise/);

  // WHICH document closes is not in initiative_status's document list — only `next_move`
  // names it. So ask for it rather than assume: the closing document is NOT necessarily the
  // last one. In ops-flow the verdict goes on the agreement (spec.md, `closing: true`) while
  // the guide only has to exist (`requiredForClose`). A probe that assumed "last document"
  // wrote a perfectly valid guide.md, saw no ledger row, and looked like a platform bug. It
  // was not.
  // THE STAGES THAT EVIDENCE THEMSELVES WITH A SOURCE, satisfied by FOLLOWING the platform's
  // own answer rather than by a list here.
  //
  // A flow's audit rounds produce a source supporting the document they audited, not a
  // document of their own, so writing and approving every declared document does not complete
  // the flow — and this probe used to believe it did. It wrote them all, asked for the next
  // move, and expected the close; the platform answered the close, and the control loop then
  // refused `close:initiative` for a round nothing had run. Two authorities over one flow.
  //
  // Now `next_move` names the owed stage, and the loop is the assertion: keep doing what the
  // platform says until it says the close. A probe that listed the audits itself would agree
  // with whatever it listed; this one can only pass if following the answer actually arrives.
  let owed = JSON.parse(await call("initiative_status", { initiative: INIT })) as {
    next_move?: { action?: string; document?: string };
  };
  // BEFORE THE ROUNDS, THE PLATFORM MUST NAME THEM. This is the half that was missing: with
  // every document written and approved and no audit run, `next_move` used to answer the
  // close — and the close would then be refused. Asserting it here means the probe can only
  // pass if the platform and the control loop agree about what the flow still owes.
  //
  // NOT A TOOL: `add_source` is next_move.action's own verb vocabulary; the tool is source_add.
  record(owed.next_move?.action === "add_source",
    "with the documents done and no audit run, the next move names the stage that is owed",
    `next_move was ${JSON.stringify(owed.next_move)}, expected the owed audit stage`);

  // NOT A TOOL: matched against `next_move.action`, which is initiative_status's own verb
  // vocabulary and not a tool name — see the comment at its registration.
  //
  // ASSERTED, NOT MERELY READ. This took `close` when it was offered and fell back to the
  // last document otherwise, which made the one state it was reading for unobservable: with
  // every gate recorded and no outcome yet, `deriveChain`'s appended handover.md became the
  // pending document, so `action: "close"` was unreachable for EVERY gating flow and this
  // probe closed the initiative anyway, off the fallback, reporting nothing. An agent
  // obeying that answer wrote a handover about an initiative that had not closed. The
  // fallback stays for the shape of the next line; the claim about what the platform says
  // is now made out loud.
  // THE AUDIT ROUNDS THIS PROBE NEVER PERFORMED, and until 0.63.0 nothing asked it to.
  //
  // This walks a flow's DOCUMENT chain: every declared document written, gated and approved.
  // That was the whole contract, so closing worked. A flow also declares a PROCEDURE, and
  // sdlc-flow's says two of its stages produce a SOURCE supporting the document they audited
  // — an audit round leaves no document of its own. This probe wrote every document and ran
  // no audit, and the reviewed module now refuses `close:initiative` for exactly that, naming
  // what is missing.
  //
  // THE REFUSAL IS CORRECT AND THIS PROBE WAS INCOMPLETE. It closed an initiative that had
  // not followed the flow it claims to drive, which is the thing the control loop exists to
  // notice. So the fix is to drive the flow properly rather than to exempt the probe: for
  // every stage that produces a source, attach one supporting the document it supports.
  //
  // Derived from the manifest rather than listing `spec.md` and `plan.md`, because a flow
  // that adds an audit stage tomorrow must make this probe do the extra round, not pass
  // while skipping it.
  for (const stage of FLOW_STAGES) {
    if (!stage.supports) continue;
    check(`an audit round attaches a source supporting ${stage.supports}`,
      await call("source_add", {
        initiative: INIT, title: `chain-check audit of ${stage.supports}`,
        content: "A round ran and found nothing blocking. Written by chain-check.",
        supports: [stage.supports],
      }), false);
  }
  // AND ONLY NOW DOES THE CLOSE BECOME THE NEXT MOVE. Re-asked rather than assumed: the
  // whole point of the assertion above is that this answer changed because the rounds ran.
  const nxtAfter = JSON.parse(await call("initiative_status", { initiative: INIT })) as typeof owed;

  // NOT A TOOL: `close` here is `next_move.action`, initiative_status's own verb vocabulary
  // — the tool it names in its `why` is initiative_close.
  record(nxtAfter.next_move?.action === "close",
    "with every gate recorded and no outcome, the next move names the close",
    `next_move was ${JSON.stringify(nxtAfter.next_move)}, expected the close action`);
  // NOT A TOOL: `close` is the action word again — the same vocabulary, read a second time
  // to pick the document out of it.
  const closing = nxtAfter.next_move?.action === "close" ? nxtAfter.next_move.document! : docs[docs.length - 1];
  console.log(`  (the flow closes on ${closing})`);

  const before = await call("document_read", { path: "_ledger.md" });

  // The close is an ACT. Writing `outcome` into frontmatter by hand is refused, because a
  // derived fact cannot be forged by choosing the cheaper word — which is what a
  // hand-written outcome always could do.
  check("an outcome written by hand is refused",
    await call("document_patch", {
      path: `${INIT}/${closing}`,
      find: "approved_by: Chain Check",
      replace: "approved_by: Chain Check\noutcome: accepted\naccepted_by: Chain Check",
    }), true, /document_patch edits the document's BODY/);


  // SKIPPED, not inverted, when the team name is unknown. With no team to send, this asserted
  // that closing accepted-by "a-team" SUCCEEDS — so a run that could not read its identity
  // closed the initiative here under a made-up acceptor, and the real close two lines below
  // then failed as a second close. A check whose name says one thing and whose assertion says
  // the opposite is worse than an absent one.
  if (team) {
    check("a close cannot be accepted by a team",
      await call("initiative_close", { initiative: INIT, disposition: "finished", accepted_by: team }),
      true, /names your team, not a person/);
  } else {
    console.log("  skip  a close cannot be accepted by a team — session_whoami named no team");
  }

  // CLOSING IS THE SIGN-OFF. The call carries a person's authority, so a close that names
  // nobody records the CALLER as the acceptor — this used to refuse until a name or a reason
  // was supplied, which was asking an authenticated caller to identify themselves twice.
  check("a close accepted by a person is recorded",
    await call("initiative_close", { initiative: INIT, disposition: "finished" }), false);
  const closedDoc = await call("document_read", { path: `${INIT}/${closing}` });
  record(/outcome: accepted/.test(closedDoc) && /accepted_by: \S/.test(closedDoc),
         "a close with nobody named records the caller as the acceptor", closedDoc);

  // An initiative closes ONCE. A second close used to overwrite the document's outcome while
  // ledgerOnClose skipped the second row, so the document said one word and the team's ledger
  // — which is what the OKR grading and the cross-flow comparison count — said another.
  //
  // THE SAME DISPOSITION, because `abandoned` never reaches this guard. An initiative whose
  // gates are all approved is refused as a CONTRADICTION first — "does not look abandoned" —
  // which is the platform being right about a different rule, and left this step reporting a
  // failure against a close guard it had not managed to exercise.
  check("an initiative cannot be closed twice",
    await call("initiative_close", { initiative: INIT, disposition: "finished", accepted_by: "Chain Check" }),
    true, /already closed as/);

  // AND THE WAY ROUND THAT GUARD. initiative_close() and ledgerOnClose both refuse a second close by
  // reading `outcome` off the document, so anything able to REMOVE that field reopens the
  // initiative and lets the close run again — a second ledger row for the same work, in the
  // file the OKR grading and the cross-flow comparison count. document_revise cleared it, as
  // one of the governance fields it puts back to draft, while leaving `closed_by` standing.
  // The check above cannot see that: it asks whether initiative_close() refuses, and after a revision
  // initiative_close() has nothing to refuse.
  //
  // THE INVARIANT IS THE LEDGER, NOT THE REVISION. This asserted that document_revise REFUSES
  // a document recording a close, because revise used to clear `outcome` as one of the
  // governance fields it returns to draft — which reopened the initiative and let the close run
  // again, putting a second row in the file the OKR grading and the cross-flow comparison count.
  //
  // Measured on the live platform: the revision is now ACCEPTED and `outcome: accepted` and
  // `closed_by` both survive it, so the way round the guard is closed at the source rather than
  // by forbidding the edit. Asserting the refusal would now pin an implementation detail that
  // has been improved on, and would fail against a platform doing the better thing.
  //
  // So the probe does what the attack did — revise the closing document — and then asserts the
  // property that actually matters: a second close is still refused.
  //
  // WITH MATERIAL, because every content change names some. `self_edit` used to be the route for
  // a version nothing caused and is gone: the platform refuses a revision that cites nothing,
  // whatever the edit was, so the probe passes the words that caused it like any other caller.
  check("a closed document may be revised, and the outcome survives it",
    await call("document_revise", {
      path: `${INIT}/${closing}`, content: doc("reopened", closing),
      source_content: "chain-check rewrote its own closing document to prove the outcome survives a revision.",
      source_title: "chain-check: revising a closed document",
    }), false);
  // MATCHED ON THE KERNEL'S WORDS, because the kernel is where the rule moved.
  //
  // This asked for `/closes once/`, which was the service's own sentence before
  // `closeInitiative` took the rule over and reworded it — "the disposition that closed the
  // work is not written twice". The refusal never stopped happening; only its wording moved,
  // and this probe has been failing since that delivery. Nobody saw it because nobody
  // attempted a release until now, which is the whole argument for the release running it.
  check("revising the closing document does not let the initiative close twice",
    await call("initiative_close", { initiative: INIT, disposition: "finished", accepted_by: "Chain Check" }),
    true, /not written twice/);

  // And the document says what the close recorded, not merely that the call was accepted.
  // "not refused" is a claim about the call; this is a claim about the record.
  const closed = await call("document_read", { path: `${INIT}/${closing}` });
  record(/outcome:\s*accepted/.test(closed), "the closing document carries the outcome", closed.slice(0, 200));
  record(/closed_by:\s*\S+/.test(closed), "the closing document names who closed it", closed.slice(0, 200));

  // reconcile joins what a stage PREDICTED about a block against what the platform later
  // recorded happening to it. zz.decision had been written on every index and read by
  // nothing since it was added — a table nobody queries is a table nobody notices going
  // wrong.
  const rec = await call("knowledge_reconcile", { initiative: INIT });
  record(!rec.trim().toUpperCase().startsWith("ERROR"), "reconcile answers for an initiative", rec);

  // ── the rest of the artifact-store door: reading, sourcing, listing, the skill shelf ──
  //
  // The closing document is still readable, still listed, and still a valid `supports`
  // target after close — none of these tools gate on the initiative's own lifecycle, and
  // asserting that stays true is the point: a reader reaching for the record of what just
  // happened here should not discover these tools quietly stopped working once it did.

  check("document_present renders the closing document for a person",
    await call("document_present", { path: `${INIT}/${closing}` }), false);

  const listed = await call("document_list", { prefix: INIT });
  record(!listed.trim().toUpperCase().startsWith("ERROR") && listed.includes(closing),
    "document_list finds what this run just wrote", listed);

  check("source_add attaches material to the initiative",
    await call("source_add", {
      initiative: INIT, title: "chain-check source", content: "material chain-check attached.",
      supports: closing,
    }), false);
  const sourced = await call("source_list", { initiative: INIT });
  record(!sourced.trim().toUpperCase().startsWith("ERROR") && sourced.includes("chain-check source"),
    "source_list reads back what source_add just wrote", sourced);

  // AND A SOURCE CANNOT BE REWRITTEN AFTERWARDS, which is what `source_add` promises in its
  // own description and what nothing enforced. `document_write` into `sources/` has three
  // path segments, so chainFor returns an empty chain and every documentGuards check
  // short-circuits — the overwrite landed with a fresh envelope carrying no
  // `contributed_by`, no `supports` and no `added_at`, which takes the source out of
  // source_list's attribution and out of document_revise's owed-sources check. Evidence that
  // can change after a document cited it makes every revision it justified unauditable.
  const sourcePath = /(sources\/[^\s)]+\.md)/.exec(sourced)?.[1];
  if (sourcePath) {
    check("a registered source cannot be overwritten by document_write",
      await writeDoc(`${INIT}/${sourcePath}`, "rewritten evidence"), true, /immutable/);
  } else {
    console.log("  skip  a registered source cannot be overwritten — source_list named no path");
  }

  // THE SHELF — skills, the knowledge store and the evaluation door — is its own subject and
  // its own file, handed the same client and the same recorders so it walks the same door.
  await walkShelf({ call, check, record, eitherOr, INIT });

  await walkBugs({ call, check, record, INIT, manage: manageDoor });

  // knowledge_reindex, ON /manage, and probed through its REFUSAL rather than its rebuild.
  //
  // Two reasons, and neither is squeamishness. A bare call means EVERY team on the deployment,
  // which is real work against a live index for a probe that would learn nothing from doing
  // it; and the refusal is the half of this tool's contract that is new — a slug no team
  // carries has to come back NAMED, because reindexTeam deletes the rows of a team with no
  // store directory and a typo has no directory either.
  //
  // THE DOOR'S OWN LIST DECIDES WHETHER IT RUNS. The tool is registered `if (sup)`, so a PAT
  // whose role is not superadmin is not offered it — a fact about this run's token, not a
  // defect — and `call` THROWS McpError on a tool the door does not publish, which would end
  // the walk here rather than record anything.
  const manageTools = new Set((await manageDoor.tools()).map((t) => t.name));
  if (manageTools.has("knowledge_reindex")) {
    check("knowledge_reindex refuses a team slug no team carries, by name",
      await manageDoor.call("knowledge_reindex", { team: "chain-check-no-such-team" }),
      true, /chain-check-no-such-team/);
  } else {
    // NOT `record(true, …)`. A probe that did not run is not a probe that passed, and this
    // file's whole output is a count somebody reads at release: a green line for a
    // measurement nobody took is the flattering direction. Said out loud, counted nowhere.
    console.log("  skip  knowledge_reindex is on /manage behind `if (sup)` and this token's " +
                "role is not offered it — nothing measured");
  }

  // ── the plugin-eval surface, in chain-eval.ts ──
  await walkEvalDoor({ callEval, eitherOr, PLUGIN });

  // MATCHED AS A CELL, NOT AS A SUBSTRING. This probe also opens `<INIT>-freeform`, whose name
  // CONTAINS INIT — so closing the freeform one first put a row in the ledger that
  // `before.includes(INIT)` read as "this initiative was already there", and the assertion
  // failed on a ledger that was behaving perfectly. The ledger is a markdown table; a row names
  // its initiative between pipes, and that is what distinguishes the two.
  const after = await call("document_read", { path: "_ledger.md" });
  const row = `| ${INIT} |`;
  record(after.includes(row) && !before.includes(row),
    "closing appends a ledger row the model cannot write", after.slice(-160));

  const bad = RESULTS.filter((r) => !r.ok);
  console.log(`\n${RESULTS.length - bad.length}/${RESULTS.length} platform checks passed`);
  for (const r of bad) console.log(`  FAILED: ${r.name}\n          ${r.got}`);
  return bad.length ? 1 : 0;
}

process.exit(await main());
