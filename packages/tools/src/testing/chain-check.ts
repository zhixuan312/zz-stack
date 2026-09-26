/**
 * Walk a flow's document chain with direct MCP calls — no model in the loop.
 *
 *   ZZ_GATEWAY=<gateway> ZZ_PAT=<a person's token> npm run chain-check -- [initiative]
 *
 * Without an initiative it opens a fresh one each run: every check here assumes an initiative
 * that does not exist yet.
 *
 * Asks only what the platform is responsible for on its own — are the gates enforced, is the
 * chain ordered, does closing record itself — so no model provider has to be reachable.
 *
 * DELIBERATE: not in scripts/gate.ts. The gate is offline; this needs a live deployment and a
 * real token.
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
 * A fresh initiative each run, unless one is named.
 *
 * Every check below assumes an initiative that does not exist yet: the first write opens it,
 * the approvals are the first, the close is the first. A fixed slug therefore works once per
 * store. Passing an initiative explicitly re-enters one deliberately.
 */
function freshSlug(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `chain-check-${p(d.getDate())}${p(d.getMonth() + 1)}-${randomUUID().slice(0, 4)}`;
}
/** A slug, not a name. The platform composes `<YYYY-MM-DD>-<slug>` from its own clock, and
 * this probe must not compose one of its own. */
const SLUG = freshSlug();
/** Filled from what `initiative_open` hands back, or from the positional argument when a run
 * re-enters an existing initiative. `let` because only the platform knows the name until the
 * open returns. */
let INIT = parseArgs(process.argv.slice(2)).positional[0] ?? "";

// Which flow this document belongs to. A team running one flow needs no such line — the
// platform infers it. A team running two cannot: nothing else says which gates apply, and the
// write is refused. The default must name a flow this catalog declares.
const FLOW = (process.env.CHAIN_FLOW || "sdlc-flow").trim();

const DECLARED = flowDeclaration(FLOW)
  ?? die(`no catalog manifest for flow '${FLOW}' — set CHAIN_FLOW to a flow this checkout declares`);
const FLOW_STAGES = DECLARED.sourceStages;
const DOCUMENTS = DECLARED.documents;
const OPENS_ON = DOCUMENTS[0].name;
/** The first gated document, which is where every approval rule can be exercised.
 *
 * The document a flow opens on is not necessarily gated — sdlc-flow opens on explore.md, which
 * carries none. The platform stamps `status` only where the manifest declares a gate, and
 * `document_approve` refuses a document that carries none. */
const FIRST_GATED = (DOCUMENTS.find((d) => d.gate === true) ?? DOCUMENTS[0]).name;

/** The headings a document must carry, from the manifest that requires them.
 *
 * sdlc-flow declares `sections` on explore.md, spec.md and plan.md and document_write enforces
 * them, so a fixed body is refused. */
const SECTIONS = new Map<string, string[]>(
  DOCUMENTS.filter((d) => d.sections?.length).map((d) => [d.name, d.sections as string[]]));

/** Replace the catalog's answer with the platform's, once an initiative exists.
 *
 * The manifest in this checkout is not the whole rule: `chain.ts` appends the handover document
 * below every flow's own list, with sections of its own that appear in no flow.json.
 * initiative_status returns `sections` per document, covering both halves. */
async function loadSectionsFromPlatform(initiative: string): Promise<void> {
  try {
    const status = JSON.parse(await call("initiative_status", { initiative })) as {
      documents?: { name: string; sections?: string[] }[];
    };
    for (const d of status.documents ?? []) {
      if (d.sections?.length) SECTIONS.set(d.name, d.sections);
    }
  } catch {
    // The catalog's answer stands. The steps below report their own failures.
  }
}
const sectionsFor = (name: string): string[] => SECTIONS.get(name) ?? [];

/**
 * The plugin the plugin-eval tools are exercised against, below. Resolved from FLOW through the
 * same `pluginName` the core's `entryOf` uses, rather than a second identifier to keep in sync.
 */
const PLUGIN = pluginName(FLOW);

const core = new Mcp(`${GW}/core/mcp`, { pat: PAT, client: "chain-check" });

/** A tool's text, refusals included — a refusal is what most checks here assert on. */
const call = (tool: string, args: unknown): Promise<string> => core.call(tool, args);

/** The evaluation door is a second client, not a second path on the first: the evaluation
 * tools are served by `/eval/mcp`, and calling them on the core door answers "tool not found".
 *
 * COUPLED: checks/chain-check-wiring.ts asserts every tool is exercised through the client for
 * the door that serves it. */
const evalDoor = new Mcp(`${GW}/eval/mcp`, { pat: PAT, client: "chain-check" });
const callEval = (tool: string, args: unknown): Promise<string> => evalDoor.call(tool, args);


/** What the two sections a spec's approval reads must hold, where a probe body would be refused. */
const SECTION_BODY: Record<string, string> = {
  "Phase outline": "- **Phase 0 — Probe:** the chain check runs end to end.",
  "Core statements": "| ID | Statement | If false | Status | Evidence | Note |\n|---|---|---|---|---|---|\n" +
    "| CS-1 | The probe runs. | Nothing is checked. | fails | run:chain-check — `probe` | resolved-by-design-change: a probe has no design |",
};

/**
 * A probe document: the body, and nothing else.
 *
 * `flow` is a caller argument to initiative_open, and the platform stamps every envelope field
 * from it. document_write refuses content that opens with frontmatter.
 */
function doc(body: string, name = ""): string {
  const wanted = sectionsFor(name);
  // Each heading gets a line of its own under it: the platform refuses a declared section that
  // is present as a heading and empty underneath.
  const sections = wanted.map((h) => `## ${h}\n\n${SECTION_BODY[h] ?? body}\n`).join("\n");
  return `# chain check\n\n${body}\n${sections ? `\n${sections}` : ""}`;
}

/** A write. The flow is not an argument here — it is declared once, to `initiative_open`, and
 * `document_write` refuses one outright.
 *
 * The document's name reaches `doc()` so the body can carry the sections that document is
 * declared to need. `path` is `<initiative>/<name>`, and the manifest keys on the name. */
const writeDoc = (path: string, body: string): Promise<string> =>
  call("document_write", { path, content: doc(body, path.split("/").pop() ?? "") });

async function main(): Promise<number> {
  // Opening is its own act, and every write below depends on it: `document_write` and
  // `source_add` both refuse a path whose initiative was never opened. The name comes back from
  // the platform, which prepends today's date to the slug.
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
    // A second open of the same slug is refused. Two folders for one slug diverge with nothing
    // able to say which was meant.
    check("a slug already taken is refused",
      await call("initiative_open", { slug: SLUG }), true, /already taken/);
    // And the other direction: the flow-driven initiative opened above must still be told its
    // first document.
    const govNext = JSON.parse(
      await call("initiative_status", { initiative: INIT })) as { next_move?: { action?: string } };
    record(govNext.next_move?.action === "write_document",
      "a flow-driven initiative is told its first document",
      `governed next_move was ${JSON.stringify(govNext.next_move)}, expected write_document`);
    await walkFreeform({ call, check, record, writeDoc, SLUG, FLOW, OPENS_ON });

  }
  console.log(`walking ${INIT}/ through ${GW}`);

  // A gate is passed by a person, on a day, and the platform is what knows both. A hand-written
  // `status` field is refused by ownershipCheck, one layer before the attribution guard.
  check("a draft needs no approver", await writeDoc(`${INIT}/${OPENS_ON}`, "intent"), false);

  // The platform authored `status` on that write. Nothing else could have: the document went
  // in without the field.
  const opened = await call("document_read", { path: `${INIT}/${OPENS_ON}` });
  // A status is a gate verdict, so it exists only where the flow declares a gate: `status: draft`
  // on a gated document, nothing at all on an ungated one.
  const opensGated = DOCUMENTS[0].gate === true;
  record(opensGated === opened.includes("status: draft"),
         opensGated
           ? `${OPENS_ON} is gated, so it opens as a draft the platform stamped`
           : `${OPENS_ON} carries no gate, so the platform stamps it no status`,
         opened);

  // And it stays without one through a revision: document_revise leaves an ungated document with
  // no status rather than putting it back to `draft`.
  if (!opensGated) {
    check(`revising ${OPENS_ON} is accepted`,
      await call("document_revise", {
        path: `${INIT}/${OPENS_ON}`, content: doc("revised", OPENS_ON),
        source_content: "chain-check revised the opening document to prove an ungated one stays ungated.",
        source_title: "chain-check: revising an ungated document",
      }), false);
    const revised = await call("document_read", { path: `${INIT}/${OPENS_ON}` });
    // DELIBERATE: through parseEnvelope, the one reader of an envelope. A regex here would be a
    // second one, and the two disagree the first time a value repeats or a body line starts with
    // the same word.
    record(parseEnvelope(revised).status === undefined,
           `${OPENS_ON} carries no gate, so a revision leaves it no status`, revised);
  }

  // The gated document, written here so the approval rules below have one to run on, in flow
  // order — everything it requires is already on the record. The patch below runs on a draft,
  // while `status: draft` is still in the file.
  if (FIRST_GATED !== OPENS_ON) {
    check(`write ${FIRST_GATED}`, await writeDoc(`${INIT}/${FIRST_GATED}`, FIRST_GATED), false);
  }
  check("an approval written by hand is refused",
    await call("document_patch", { path: `${INIT}/${FIRST_GATED}`, find: "status: draft", replace: "status: approved" }),
    true, /document_patch edits the document's BODY/);

  // A gated draft is rewritten by document_write, and the platform's own fields survive it: the
  // rewrite's envelope carries no `status`, which ownershipCheck must not read as a hand removal,
  // and `version` must not reset to 1 — a reset makes the next revise write a `_versions/`
  // snapshot over one that already exists.
  check(`a gated draft is rewritten by document_write`,
    await writeDoc(`${INIT}/${FIRST_GATED}`, `${FIRST_GATED} rewritten`), false);
  const rewritten = parseEnvelope(await call("document_read", { path: `${INIT}/${FIRST_GATED}` }));
  record(rewritten.status === "draft" && (rewritten.version ?? "1") === "1",
    "a rewrite keeps the platform's own fields",
    `after the rewrite status was ${JSON.stringify(rewritten.status)} and version ` +
    `${JSON.stringify(rewritten.version)}, expected draft and 1`);

  // An ungated document cannot be approved. It is finished by being written; there is no verdict
  // to record.
  if (FIRST_GATED !== OPENS_ON) {
    check("document_approve() refuses a document its flow does not gate",
      await call("document_approve", { path: `${INIT}/${OPENS_ON}`, on_behalf_of: "Chain Check" }),
      true, /carries no gate/);
  }

  // An approval signs bytes somebody was shown: refused until the current content was presented.
  check("document_approve() refuses a document not presented since its last change",
    await call("document_approve", { path: `${INIT}/${FIRST_GATED}`, on_behalf_of: "Chain Check" }),
    true, /present it first/);
  await call("document_present", { path: `${INIT}/${FIRST_GATED}` });
  check("document_approve() records a verdict on a document that exists",
    await call("document_approve", { path: `${INIT}/${FIRST_GATED}`, on_behalf_of: "Chain Check" }), false);
  check("document_approve() refuses a document that does not",
    await call("document_approve", { path: `${INIT}/nothing-here.md` }), true,
    /does not exist|not a document this flow declares/);

  // Both halves, read back — the tool reporting success is the tool's own account of itself.
  const signed = await call("document_read", { path: `${INIT}/${FIRST_GATED}` });
  const both = signed.includes("approved_by: Chain Check") && /approved_at: \d{4}-\d{2}-\d{2}/.test(signed);
  record(both, "document_approve() stamps an approver AND a day", signed);

  const status = JSON.parse(await call("initiative_status", { initiative: INIT })) as {
    documents: { name: string; status?: string | null; gate?: boolean }[];
    next_move?: { action?: string; document?: string };
  };
  // The flow's own documents, without the platform's handover. `initiative_status.documents`
  // includes the handover the platform appends to every gating flow, and the handover is written
  // after the close — zz-handover requires the outcome to exist already.
  const docs = status.documents.filter((d) => d.name !== "handover.md").map((d) => d.name);
  // What is already approved, from the platform's own answer, whether or not it is gated:
  // document_write on an approved document is refused, and a gate decides whether an approval is
  // required, never whether one that exists may be overwritten. That refusal is asserted directly
  // further down.
  const settled = new Set(status.documents
    .filter((d) => d.status === "approved").map((d) => d.name));
  // The team, from the platform rather than an environment variable — the team-rejection check
  // below is only meaningful if it passes the real team name.
  let team = "";
  try {
    team = ((JSON.parse(await call("session_whoami", {})) as { team?: string }).team ?? "").trim();
  } catch {
    // No identity to read: the team-name check below asserts nothing about a team.
  }

  // Order is enforced: a document cannot be written before what it requires.
  if (docs.length > 2) {
    check("the chain cannot be skipped",
      await writeDoc(`${INIT}/${docs[docs.length - 1]}`, "early"),
      true, /the flow writes it first|approval gate has not been recorded/);
  }

  // Write each document as a draft and approve it as a separate act. Documents already approved
  // are skipped: writing over an approved gated document is refused, and `document_approve`
  // refuses a document the manifest declares without a gate.
  const gatedName = new Set(status.documents.filter((d) => d.gate === true).map((d) => d.name));
  for (const name of docs) {
    if (settled.has(name)) continue;
    check(`write ${name}`, await writeDoc(`${INIT}/${name}`, name), false);
    if (gatedName.has(name)) {
      // A verifying document (review.md) approves only once its sweep has run a round: one
      // source naming the stage that writes it, carrying an empty ledger.
      const verifying = DECLARED.documents.find((d) => d.name === name && d.verifies?.length);
      if (verifying?.stage) {
        check(`a review round attaches a source supporting ${name}`, await call("source_add", {
          initiative: INIT, title: `chain-check review of ${name}`, supports: [name], stage: verifying.stage,
          content: "A round ran and found nothing blocking. Written by chain-check.\n\n```json\n" +
            JSON.stringify({ round: 1, scope: { base: "HEAD~1", head: "HEAD" }, findings: [], resolved: [] }) + "\n```\n",
        }), false);
      }
      await call("document_present", { path: `${INIT}/${name}` });
      check(`approve ${name}`, await call("document_approve", { path: `${INIT}/${name}`, on_behalf_of: "Chain Check" }), false);
    }
  }

  // And the refusal the skip above relies on, asserted rather than assumed: an approved gated
  // document does not change through document_write.
  check("an approved document does not change through document_write",
    await writeDoc(`${INIT}/${FIRST_GATED}`, "rewritten"),
    true, /document_revise/);

  // Which document closes is not in initiative_status's document list — only `next_move` names
  // it, and it is not necessarily the last one. A flow's audit rounds produce a source supporting
  // the document they audited rather than a document of their own, so writing and approving every
  // declared document does not complete the flow. The loop below keeps doing what `next_move`
  // says until it says the close.
  let owed = JSON.parse(await call("initiative_status", { initiative: INIT })) as {
    next_move?: { action?: string; document?: string };
  };
  // Before the rounds, the platform must name them: with every document written and approved and
  // no audit run, the next move is the owed audit stage rather than the close.
  //
  // NOT A TOOL: `add_source` is next_move.action's own verb vocabulary; the tool is source_add.
  record(owed.next_move?.action === "add_source",
    "with the documents done and no audit run, the next move names the stage that is owed",
    `next_move was ${JSON.stringify(owed.next_move)}, expected the owed audit stage`);

  // The audit rounds. sdlc-flow declares two stages that produce a source supporting the document
  // they audited and no document of their own, and the reviewed module refuses `close:initiative`
  // when one is missing. Derived from the manifest rather than listing `spec.md` and `plan.md`, so
  // a flow that adds an audit stage tomorrow makes this probe do the extra round.
  //
  // NOT A TOOL: matched against `next_move.action`, which is initiative_status's own verb
  // vocabulary and not a tool name.
  for (const stage of FLOW_STAGES) {
    if (!stage.supports) continue;
    check(`an audit round attaches a source supporting ${stage.supports}`,
      await call("source_add", {
        initiative: INIT, title: `chain-check audit of ${stage.supports}`,
        content: "A round ran and found nothing blocking. Written by chain-check.",
        // A source is a round only when it names its stage; without it the audit step stays owed.
        supports: [stage.supports], stage: stage.name,
      }), false);
  }
  // And only now does the close become the next move. Re-asked rather than assumed: the point of
  // the assertion above is that this answer changed because the rounds ran.
  const nxtAfter = JSON.parse(await call("initiative_status", { initiative: INIT })) as typeof owed;

  // NOT A TOOL: `close` here is `next_move.action`, initiative_status's own verb vocabulary —
  // the tool it names in its `why` is initiative_close.
  record(nxtAfter.next_move?.action === "close",
    "with every gate recorded and no outcome, the next move names the close",
    `next_move was ${JSON.stringify(nxtAfter.next_move)}, expected the close action`);
  // NOT A TOOL: `close` is the action word again — the same vocabulary, read a second time to
  // pick the document out of it.
  const closing = nxtAfter.next_move?.action === "close" ? nxtAfter.next_move.document! : docs[docs.length - 1];
  console.log(`  (the flow closes on ${closing})`);

  const before = await call("document_read", { path: "_ledger.md" });

  // The close is an act. Writing `outcome` into frontmatter by hand is refused: a derived fact
  // cannot be forged by choosing the cheaper word.
  check("an outcome written by hand is refused",
    await call("document_patch", {
      path: `${INIT}/${closing}`,
      find: "approved_by: Chain Check",
      replace: "approved_by: Chain Check\noutcome: accepted\naccepted_by: Chain Check",
    }), true, /document_patch edits the document's BODY/);


  // DELIBERATE: skipped, not inverted, when the team name is unknown. Asserting that a close
  // accepted by a made-up team name succeeds would close the initiative here, and the real close
  // below would then fail as a second close.
  if (team) {
    check("a close cannot be accepted by a team",
      await call("initiative_close", { initiative: INIT, disposition: "finished", accepted_by: team }),
      true, /names your team, not a person/);
  } else {
    console.log("  skip  a close cannot be accepted by a team — session_whoami named no team");
  }

  // Closing is the sign-off. The call carries a person's authority, so a close that names nobody
  // records the caller as the acceptor.
  check("a close accepted by a person is recorded",
    await call("initiative_close", { initiative: INIT, disposition: "finished" }), false);
  const closedDoc = await call("document_read", { path: `${INIT}/${closing}` });
  record(/outcome: accepted/.test(closedDoc) && /accepted_by: \S/.test(closedDoc),
         "a close with nobody named records the caller as the acceptor", closedDoc);

  // An initiative closes once. A second close must not overwrite the document's outcome while
  // ledgerOnClose skips the second row — the document and the team's ledger would say different
  // words.
  //
  // DELIBERATE: the same disposition. `abandoned` never reaches this guard — an initiative whose
  // gates are all approved is refused as a contradiction first.
  check("an initiative cannot be closed twice",
    await call("initiative_close", { initiative: INIT, disposition: "finished", accepted_by: "Chain Check" }),
    true, /already closed as/);

  // And the way round that guard: initiative_close() and ledgerOnClose both refuse a second close
  // by reading `outcome` off the document, so anything able to remove that field would reopen the
  // initiative and put a second ledger row against the same work.
  //
  // DELIBERATE: the revision is asserted to be accepted, not refused — `outcome: accepted` and
  // `closed_by` survive it. A revision must cite material; the platform refuses one that cites
  // nothing.
  check("a closed document may be revised, and the outcome survives it",
    await call("document_revise", {
      path: `${INIT}/${closing}`, content: doc("reopened", closing),
      source_content: "chain-check rewrote its own closing document to prove the outcome survives a revision.",
      source_title: "chain-check: revising a closed document",
    }), false);
  // Matched on the kernel's words, because the kernel is where the rule lives: `closeInitiative`
  // words the refusal "the disposition that closed the work is not written twice".
  check("revising the closing document does not let the initiative close twice",
    await call("initiative_close", { initiative: INIT, disposition: "finished", accepted_by: "Chain Check" }),
    true, /not written twice/);

  // And the document says what the close recorded, not merely that the call was accepted.
  // "not refused" is a claim about the call; this is a claim about the record.
  const closed = await call("document_read", { path: `${INIT}/${closing}` });
  record(/outcome:\s*accepted/.test(closed), "the closing document carries the outcome", closed.slice(0, 200));
  record(/closed_by:\s*\S+/.test(closed), "the closing document names who closed it", closed.slice(0, 200));

  // reconcile answers with the claims a stage recorded for the initiative.
  const rec = await call("knowledge_reconcile", { initiative: INIT });
  record(!rec.trim().toUpperCase().startsWith("ERROR"), "reconcile answers for an initiative", rec);

  // A checkpoint question answers with a reading — `unavailable`, with its reason, on a
  // deployment with no typed-service key — and never as a refusal.
  const assessed = await call("assess", {
    family: "actionability", subject: "Rename the heading `Scope` to `Scope and limits`.",
    initiative: INIT, about: "chain-check",
  });
  record(/"reading":\s*"(yes|no|unclear|unavailable)"/.test(assessed),
    "assess answers a registered family with a reading", assessed.slice(0, 200));

  // The rest of the artifact-store door: reading, sourcing, listing, the skill shelf. None of
  // these tools gate on the initiative's own lifecycle — the closing document is still readable,
  // still listed, and still a valid `supports` target after close.

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

  // And a source cannot be rewritten afterwards. `document_write` into `sources/` has three path
  // segments, so chainFor returns an empty chain and every documentGuards check short-circuits:
  // the overwrite lands with a fresh envelope carrying no `contributed_by`, no `supports` and no
  // `added_at`.
  const sourcePath = /(sources\/[^\s)]+\.md)/.exec(sourced)?.[1];
  if (sourcePath) {
    check("a registered source cannot be overwritten by document_write",
      await writeDoc(`${INIT}/${sourcePath}`, "rewritten evidence"), true, /immutable/);
  } else {
    console.log("  skip  a registered source cannot be overwritten — source_list named no path");
  }

  // The shelf — skills, the knowledge store and the evaluation door — is its own file, handed the
  // same client and the same recorders so it walks the same door.
  await walkShelf({ call, check, record, eitherOr, INIT });

  await walkBugs({ call, check, record, INIT, admin: core });

  // knowledge_reindex, probed through its refusal rather than its rebuild: a bare call means every
  // team on the deployment. A slug no team carries comes back named, because reindexTeam deletes
  // the rows of a team with no store directory and a typo has no directory.
  //
  // Registered `if (sup)`, so a PAT whose role is not superadmin is not offered it, and `call`
  // throws McpError on a tool the door does not publish.
  const coreTools = new Set((await core.tools()).map((t) => t.name));
  if (coreTools.has("knowledge_reindex")) {
    check("knowledge_reindex refuses a team slug no team carries, by name",
      await call("knowledge_reindex", { team: "chain-check-no-such-team" }),
      true, /chain-check-no-such-team/);
  } else {
    // DELIBERATE: a skip, not `record(true, …)`. A probe that did not run is not a probe that
    // passed, and this file's output is a count somebody reads at release.
    console.log("  skip  knowledge_reindex is behind `if (sup)` and this token's " +
                "role is not offered it — nothing measured");
  }

  // The plugin-eval surface, in chain-eval.ts.
  await walkEvalDoor({ callEval, eitherOr, PLUGIN });

  // Matched as a cell, not as a substring: this probe also opens `<INIT>-freeform`, whose name
  // contains INIT. The ledger is a markdown table, and a row names its initiative between pipes.
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
