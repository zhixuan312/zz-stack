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
 * It is deliberately not part of scripts/gate.mjs: the gate is offline and proves things
 * about the source, while this needs a running deployment and a real token.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { manifestAt } from "@zz/catalog";
import { Mcp } from "@zz/mcp-client";

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

/**
 * The flow's FIRST document, from the flow's own manifest.
 *
 * This opened on a hardcoded `intent.md`. ops-flow declares one and sdlc-flow does not — it
 * opens on explore.md — so CHAIN_FLOW=sdlc-flow wrote a document that flow has never heard
 * of, which no gate governs, and then walked a chain it had already stepped outside of. The
 * whole point of CHAIN_FLOW is that this deployment runs both.
 *
 * Read from the checkout, the way manifest-audit reads it: nothing on the tool surface names
 * a flow's documents before the initiative exists, and the manifest is the same file the
 * platform resolves the chain from.
 */
function flowDocuments(): { name: string; sections?: string[] }[] {
  const catalog = join(dirname(fileURLToPath(import.meta.url)), "../../../../catalog");
  if (existsSync(catalog)) {
    for (const owner of readdirSync(catalog)) {
      const manifest = join(catalog, owner, FLOW, "flow.json");
      if (!existsSync(manifest)) continue;
      // Through @zz/catalog's reader, like every other manifest read. A cast here would accept
      // a manifest the platform itself refuses, and this probe would then walk a chain the
      // deployment does not enforce and report the difference as a platform fault. A throw
      // would be no better: this walks every owner looking for one flow, so one unreadable
      // manifest anywhere in the catalog ended the probe before it reached the right one.
      const read = manifestAt(manifest);
      if (!read.manifest) {
        console.error(`  (${owner}/${FLOW}/flow.json ${read.why} — looking elsewhere)`);
        continue;
      }
      const docs = read.manifest.documents ?? [];
      if (docs[0]?.name) return docs;
    }
  }
  return die(`no catalog manifest for flow '${FLOW}' — set CHAIN_FLOW to a flow this checkout declares`);
}
const DOCUMENTS = flowDocuments();
const OPENS_ON = DOCUMENTS[0].name;

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
 * resolves a plugin from a flow the same way — `e.flow.replace(/-flow$/, "") === plugin` —
 * so this names the same catalog entry FLOW already had to resolve for `firstDocument()` to
 * succeed, rather than a second identifier this script would have to keep in sync with it.
 */
const PLUGIN = FLOW.replace(/-flow$/, "");

const core = new Mcp(`${GW}/core/mcp`, { pat: PAT, client: "chain-check" });

/** A tool's text, refusals included — a refusal is what most checks here assert on. */
const call = (tool: string, args: unknown): Promise<string> => core.call(tool, args);

/** THE EVALUATION DOOR IS A SECOND CLIENT, not a second path on the first.
 *
 * The ten `plugin_*` tools left `/core/mcp` for `/eval/mcp` in Task I-19, and this file opened
 * exactly one client. Calling them on the core door answers "tool not found" ten times — at
 * RELEASE, because `release.mjs` runs this and the offline gate deliberately does not, so
 * nothing before a release would have said so. `checks/chain-check-wiring.mjs` could not catch
 * it either: it asserts every tool registered under `services/zz-core/src/tools` is exercised,
 * one direction only, so ten tools LEAVING that directory made it quieter rather than redder. */
const evalDoor = new Mcp(`${GW}/eval/mcp`, { pat: PAT, client: "chain-check" });
const callEval = (tool: string, args: unknown): Promise<string> => evalDoor.call(tool, args);

/** THE ACCESS DOOR IS A THIRD CLIENT, for the reason the evaluation door became a second one.
 *
 * `knowledge_reindex` left `/core/mcp` for `/manage/mcp` at Task I-38 — rebuilding a team's
 * index is an administrative act on a team, not a step in anybody's flow — and this file
 * opened no client that could reach it. The probe below would answer "tool not found" at
 * RELEASE, because release.mjs runs this and the offline gate deliberately does not. */
const manageDoor = new Mcp(`${GW}/manage/mcp`, { pat: PAT, client: "chain-check" });

const RESULTS: { ok: boolean; name: string; got: string }[] = [];

function record(ok: boolean, name: string, got: string): void {
  RESULTS.push({ ok, name, got: got.trim().slice(0, 200) });
  console.log((ok ? "  ok   " : "  FAIL ") + name);
}

/**
 * `because` is what stops a check passing on the wrong refusal.
 *
 * "the call errored" and "the rule fired" are different claims, and this file already knows
 * it — the journal probe fills in every other argument precisely so a schema rejection cannot
 * be mistaken for the subject rule. The hand-written-approval probe did not have that, and it
 * patched `status: draft` on a document approved forty lines earlier: document_patch answered
 * "`find` occurs 0 times" long before any guard ran, and the check printed ok having never
 * reached ownershipCheck at all.
 */
function check(name: string, got: string, wantError: boolean, because?: RegExp): void {
  const body = got.trim();
  const err = body.toUpperCase().startsWith("ERROR");
  let ok = err === wantError;
  if (ok && err && because && !because.test(body)) {
    ok = false;
    console.log(`        refused, but not by the rule this names — wanted /${because.source}/`);
  }
  record(ok, name, got);
  if (!ok && err !== wantError) {
    console.log(`        wanted ${wantError ? "an ERROR" : "success"}, got: ${body.slice(0, 200)}`);
  }
}

/**
 * A tool whose real subject is not this run's throwaway initiative — a plugin's release
 * history, a skill's install state, an evaluation nobody has started — cannot be asserted on
 * the way `check` does: which of "did the work" or "refused" is correct depends on state this
 * script does not control and a fresh initiative does not create. So this asserts on the
 * SHAPE of the answer instead: either the tool did its work, or it refused for a cause it
 * names. An unnamed refusal, or the call throwing at all, is what actually says the tool is
 * broken.
 */
function eitherOr(name: string, got: string, acceptableRefusal: RegExp): void {
  const body = got.trim();
  const refused = /^(ERROR|REFUSED):/i.test(body);
  const ok = !refused || acceptableRefusal.test(body);
  record(ok, name, got);
  if (!ok) console.log(`        refused for an unnamed reason: ${body.slice(0, 200)}`);
}

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
    // FREEFORM IS ACCEPTED. A missing flow is a choice the platform supports, and a door that
    // refused it would make every freeform initiative unreachable — with nothing here to say
    // so, because every other assertion in this probe declares a flow.
    const freeSlug = `${SLUG}-freeform`;
    const free = await call("initiative_open", { slug: freeSlug });
    check("opening without a flow is accepted", free, false);
    const freeName = (JSON.parse(free) as { initiative?: string; next_move?: unknown }).initiative;
    record(JSON.parse(free).next_move === null,
      "a freeform initiative is given no next move",
      `freeform next_move was ${JSON.stringify(JSON.parse(free).next_move)}, expected null`);
    // AND THE OTHER DIRECTION, which is the half a null-only assertion cannot see: the
    // flow-driven initiative opened above must still be told its first document.
    const govNext = JSON.parse(
      await call("initiative_status", { initiative: INIT })) as { next_move?: { action?: string } };
    record(govNext.next_move?.action === "write_document",
      "a flow-driven initiative is told its first document",
      `governed next_move was ${JSON.stringify(govNext.next_move)}, expected write_document`);
    check("a write into an initiative nobody opened is refused",
      await writeDoc(`${SLUG}-never-opened/spec.md`, "x"), true, /initiative_open/);
    if (freeName) {
      check("a freeform initiative still takes a document",
        await writeDoc(`${freeName}/notes.md`, "hand-assembled"), false);
      check("a freeform initiative still records a gate",
        await call("document_approve", { path: `${freeName}/notes.md`, on_behalf_of: "Chain Check" }),
        false);
      check("a freeform initiative still closes, on the document it names",
        await call("initiative_close", {
          initiative: freeName, disposition: "finished", accepted_by: "Chain Check",
          document: "notes.md",
        }), false);
    }
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
  record(opened.includes("status: draft"), "a new document opens as a draft, stamped by the platform", opened);

  // ON A DRAFT, while `status: draft` is still in the file. Run after the approve loop below
  // this found nothing to replace and passed on document_patch's arity error instead of on the
  // rule — the quietest way for a suite to stop measuring what it says it measures, which is
  // the thing this file's own comments keep warning about.
  check("an approval written by hand is refused",
    await call("document_patch", { path: `${INIT}/${OPENS_ON}`, find: "status: draft", replace: "status: approved" }),
    true, /document_patch edits the document's BODY/);

  check("document_approve() records a verdict on a document that exists",
    await call("document_approve", { path: `${INIT}/${OPENS_ON}`, on_behalf_of: "Chain Check" }), false);
  check("document_approve() refuses a document that does not",
    await call("document_approve", { path: `${INIT}/nothing-here.md` }), true,
    /does not exist|not a document this flow declares/);

  // BOTH halves, from the session rather than from the model. Read back, because the tool
  // reporting success is the tool's own account of itself.
  const signed = await call("document_read", { path: `${INIT}/${OPENS_ON}` });
  const both = signed.includes("approved_by: Chain Check") && /approved_at: \d{4}-\d{2}-\d{2}/.test(signed);
  record(both, "document_approve() stamps an approver AND a day", signed);

  const status = JSON.parse(await call("initiative_status", { initiative: INIT })) as {
    documents: { name: string; status?: string | null; gate?: boolean }[];
    next_move?: { action?: string; document?: string };
  };
  const docs = status.documents.map((d) => d.name);
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
  for (const name of docs) {
    if (settled.has(name)) continue;
    check(`write ${name}`, await writeDoc(`${INIT}/${name}`, name), false);
    check(`approve ${name}`, await call("document_approve", { path: `${INIT}/${name}`, on_behalf_of: "Chain Check" }), false);
  }

  // And the refusal the skip above relies on, asserted rather than assumed: an approved gated
  // document does not change through document_write.
  check("an approved document does not change through document_write",
    await writeDoc(`${INIT}/${OPENS_ON}`, "rewritten"),
    true, /document_revise/);

  // WHICH document closes is not in initiative_status's document list — only `next_move`
  // names it. So ask for it rather than assume: the closing document is NOT necessarily the
  // last one. In ops-flow the verdict goes on the agreement (spec.md, `closing: true`) while
  // the guide only has to exist (`requiredForClose`). A probe that assumed "last document"
  // wrote a perfectly valid guide.md, saw no ledger row, and looked like a platform bug. It
  // was not.
  const nxt = JSON.parse(await call("initiative_status", { initiative: INIT })) as {
    next_move?: { action?: string; document?: string };
  };
  // NOT A TOOL: matched against `next_move.action`, which is initiative_status's own verb
  // vocabulary and not a tool name — see the comment at its registration.
  const closing = nxt.next_move?.action === "close" ? nxt.next_move.document! : docs[docs.length - 1];
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

  // Finished with nobody named is a legitimate route and costs a sentence. Refusing it
  // outright would leave the honest agent with only the dishonest option.
  check("finished with nobody named needs a reason",
    await call("initiative_close", { initiative: INIT, disposition: "finished" }), true, /no_signoff_reason/);

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

  check("a close accepted by a person is recorded",
    await call("initiative_close", { initiative: INIT, disposition: "finished", accepted_by: "Chain Check" }), false);

  // An initiative closes ONCE. A second close used to overwrite the document's outcome while
  // ledgerOnClose skipped the second row, so the document said one word and the team's ledger
  // — which is what the OKR grading and the cross-flow comparison count — said another.
  check("an initiative cannot be closed twice",
    await call("initiative_close", { initiative: INIT, disposition: "abandoned" }), true, /already closed as/);

  // AND THE WAY ROUND THAT GUARD. initiative_close() and ledgerOnClose both refuse a second close by
  // reading `outcome` off the document, so anything able to REMOVE that field reopens the
  // initiative and lets the close run again — a second ledger row for the same work, in the
  // file the OKR grading and the cross-flow comparison count. document_revise cleared it, as
  // one of the governance fields it puts back to draft, while leaving `closed_by` standing.
  // The check above cannot see that: it asks whether initiative_close() refuses, and after a revision
  // initiative_close() has nothing to refuse.
  check("a document that records a close cannot be revised",
    await call("document_revise", { path: `${INIT}/${closing}`, content: doc("reopened", closing) }),
    true, /closes once/);

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

  // skill_list and skill_read degrade (a named ERROR) rather than fail outright when this
  // deployment has no platform database — session_whoami's own team lookup already treats that
  // as ordinary above, and these two tools document the identical fallback.
  eitherOr("skill_list lists what this caller can reach",
    await call("skill_list", {}), /platform database is unreachable/);
  // zz-platform ships with the `zz` plugin, which every account carries — session_whoami points
  // here itself ("skill_read(\"zz-platform\")"), so this is the one skill name the door can
  // promise exists without reading this deployment's own catalog first.
  check("skill_read reads the platform's own spine skill",
    await call("skill_read", { name: "zz-platform" }), false);
  // THE MERGE, asserted on the half that has a right answer whatever this deployment holds.
  // Which owners exist depends on which flows are installed and which blocks are routed, so
  // the shelf itself can only be checked for shape (above). The refusal cannot: an owner id
  // nothing answers to must be refused by name, listing the ones that do, and that is the
  // behaviour skill_list took over from block_skills.
  check("skill_list refuses an owner no plugin or block answers to",
    await call("skill_list", { owner: "no-such-owner-chain-check" }), true,
    /is not a plugin or building block/);

  // A subject tag says WHAT KIND of thing a piece of knowledge is about, and the kinds are a
  // closed set. Open, it becomes a free-text field that agrees with nothing.
  //
  // Every OTHER argument is filled in, and there is a positive control below. Without both,
  // a call missing a required argument is refused by the schema, the assertion sees an ERROR
  // and prints `ok` — a check that passes without ever reaching the rule it names.
  // Evidence names the INITIATIVE FOLDER, not a document inside it — knowledge_add checks the
  // shape (one plain segment) and then that a folder by that name exists in a store this
  // caller belongs to. `${INIT}/${docs[0]}` fails both, so the positive control below could
  // never have passed, and the negative control above passed for a reason that was not the
  // one it names: subjectTagError runs before the evidence loop, so the unknown kind was
  // refused first and the fixture's own invalidity never showed.
  // `scope` has no default — knowledge_add's own schema refuses a call that omits it, before
  // the handler runs at all. This was missing here, so both calls below threw a schema error
  // rather than reaching subjectTagError: the negative control passed on the WRONG refusal
  // ("`scope` says which shelf ..." never matches /is not a kind/) and would have been caught
  // by `because`, except the throw never let it get that far. `scope: "team"` is what makes
  // this the case the comments below actually describe.
  const node = {
    title: "chain-check subject probe",
    type: "knowledge",
    body: "written by chain-check; safe to supersede.",
    evidence: [INIT],
    scope: "team" as const,
  };
  check("a knowledge subject must be a kind the platform knows",
    await call("knowledge_add", { ...node, tags: ["nonesuch:casebox"] }), true, /is not a kind/);
  const added = await call("knowledge_add", { ...node, tags: ["block:casebox"] });
  check("a known kind is accepted", added, false);

  // knowledge_supersede needs two nodes that actually exist, on the same shelf. The id is
  // this tool's own account of what it just did — "journal node 0007 created (...)" — read
  // back rather than guessed, because a fixture id increments differently on every store.
  const oldId = /journal node (\d+) created/.exec(added)?.[1];
  if (oldId) {
    const superseding = await call("knowledge_add",
      { ...node, title: "chain-check subject probe (superseding)", tags: ["block:casebox"] });
    const newId = /journal node (\d+) created/.exec(superseding)?.[1];
    if (newId) {
      check("knowledge_supersede marks a node superseded by one that exists",
        await call("knowledge_supersede", { old_id: oldId, new_id: newId }), false);
    } else {
      record(false, "knowledge_supersede marks a node superseded by one that exists",
        `could not mint a second node to supersede with: ${superseding}`);
    }
  } else {
    record(false, "knowledge_supersede marks a node superseded by one that exists",
      `could not read an id back from knowledge_add: ${added}`);
  }

  // knowledge_search refuses the identical way session_whoami's team lookup and knowledge_add's
  // own team-scope guard do — no platform database, or no team — and that is ordinary on a
  // deployment run without either, not a broken tool.
  eitherOr("knowledge_search finds the node this run just wrote",
    await call("knowledge_search", { query: "chain-check subject probe" }),
    /no platform database|no platform db|not in a team/);

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

  // ── the plugin-eval surface: a plugin's release history, not this run's initiative ──
  //
  // Every tool here takes `plugin`/`version`/`eval_id` identifiers, and whether THIS
  // deployment has ever released PLUGIN, run a judge round, or even holds a platform
  // database at all is state this throwaway initiative does not create and this script does
  // not control. So each call below is aimed at a REFUSAL these tools document for exactly
  // that case — "no released version is recorded", "declares no ruler", "is not an
  // evaluation" — rather than at manufacturing a real release, an approved rubric and a
  // scored round, which the model-scoring half of this surface needs a live judge to run at
  // all: round_judge is explicit that a real subject "takes about thirty seconds" each,
  // which is the model cost and wall-clock time this whole file exists to not spend. Getting
  // this far exercises the door, the schema and every refusal branch that runs before a
  // model is ever reached — the part of "does the tool chain still work" that a rate-limited
  // model provider cannot take down.
  eitherOr("plugin_locate answers or refuses by a named cause",
    await callEval("plugin_locate", { plugin: PLUGIN }),
    /no platform database|no released version/);
  eitherOr("plugin_conform reads this plugin's own catalog entry",
    await callEval("plugin_conform", { plugin: PLUGIN, version: "0" }),
    /is not in the catalog/);
  eitherOr("plugin_profile answers or refuses by a named cause",
    await callEval("plugin_profile", { plugin: PLUGIN, version: "0" }),
    /no platform database/);
  eitherOr("ruler_read answers or refuses by a named cause",
    await callEval("ruler_read", { plugin: PLUGIN, version: "0" }),
    /no platform database/);
  eitherOr("ruler_affirm refuses a version this deployment never released",
    await callEval("ruler_affirm", { plugin: PLUGIN, version: "0" }),
    /no platform database|no released version/);
  eitherOr("round_judge refuses a version that declares no ruler",
    await callEval("round_judge", { plugin: PLUGIN, version: "0", rubric_id: "0" }),
    /no platform database|declares no ruler/);
  eitherOr("round_scores refuses an eval_id nothing minted",
    await callEval("round_scores", { eval_id: randomUUID() }),
    /no platform database|is not an evaluation/);
  eitherOr("case_record refuses a result that is not JSON",
    await callEval("case_record", { plugin: PLUGIN, version: "0", result: "not json" }),
    /no platform database|that is not JSON/);
  eitherOr("ruler_record refuses a quantitative dimension with no threshold",
    await callEval("ruler_record", {
      plugin: PLUGIN, version: "0", rubric_version: "0", subject: "auto",
      dimensions: [{ name: "chain-check probe", kind: "quantitative" }],
    }), /no platform database|carries no threshold/);
  eitherOr("finding_record refuses an eval_id nothing minted",
    await callEval("finding_record", {
      eval_id: randomUUID(), findings: [{ pattern: "chain-check probe", scope: "specific" }],
    }), /no platform database|no evaluation/);

  const after = await call("document_read", { path: "_ledger.md" });
  record(after.includes(INIT) && !before.includes(INIT),
    "closing appends a ledger row the model cannot write", after.slice(-160));

  const bad = RESULTS.filter((r) => !r.ok);
  console.log(`\n${RESULTS.length - bad.length}/${RESULTS.length} platform checks passed`);
  for (const r of bad) console.log(`  FAILED: ${r.name}\n          ${r.got}`);
  return bad.length ? 1 : 0;
}

process.exit(await main());
