#!/usr/bin/env node
/**
 * zz-migrate — bring one mma repository's history onto the ZZ platform.
 *
 *   node migrate.mjs [repo]            # default: the current directory
 *   node migrate.mjs --dry-run         # decide everything, send nothing
 *   node migrate.mjs --limit 20        # first N of each kind, to try it on something small
 *
 * WHAT BECOMES WHAT, and why each is the only honest answer available:
 *
 * `.mma/journal/nodes/*.md` -> knowledge nodes. mma's six node types ARE the platform's six,
 *   so this is a rename and not a translation.
 *
 * Everything else historical -> SOURCES on one archive initiative. Not documents: an
 *   initiative's documents are envelope-governed and gated, `plan.md` requires an approved
 *   `spec.md`, and 212 historical plans have no approvals because nobody ever approved them
 *   under rules that did not exist yet. Importing them as documents would mean signing 212
 *   gates on behalf of people who signed nothing, which is the one thing the gates are for.
 *   `add_source` is ungated and immutable and its description says what it is for — material
 *   from elsewhere that work rests on. That is exactly what this is.
 *
 * THE EVIDENCE PROBLEM, and how it is answered. `knowledge_add` refuses a node with no
 *   evidence: "a node without evidence is an opinion". An mma journal node cites no
 *   initiative, because mma had none. So the import creates ONE archive initiative per
 *   repository first, puts the whole historical corpus in it as sources, and every migrated
 *   node cites that. The claim it makes is true and checkable: this lesson came from that
 *   body of work, and the work is right there.
 *
 * IT CAN BE RUN TWICE. Every send is recorded in `.mma/.zz-migrated.json` the moment it
 *   succeeds, so an interrupted import resumes where it stopped instead of minting a second
 *   copy of everything before it. 700 sends over a network is long enough that "what happens
 *   when it stops halfway" is a certainty, not a risk.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { Door, gateway, token } from "./mcp.mjs";
import { survey } from "./read-mma.mjs";

/** Progress on one rewritten line, and nothing at all when this is not a terminal.
 *
 * `\r` is a cursor move, not a line. Piped to a file or read by a harness it is just another
 * character, so 537 progress ticks became a 50KB transcript of a run whose result is four
 * lines. A person watching wants the tick; anything else wants the summary. */
const tick = process.stdout.isTTY
  ? (msg) => process.stdout.write(`\r${msg.padEnd(78).slice(0, 78)}`)
  : () => {};
const endTick = (msg) => console.log(process.stdout.isTTY ? `\r${msg.padEnd(78)}` : msg);

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const value = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const DRY = flag("--dry-run");
const LIMIT = Number(value("--limit", "0")) || 0;
const repoRoot = resolve(argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--limit") || ".");

const FLOW = "sdlc-flow";
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ── the ledger ─────────────────────────────────────────────────────────────
// Beside the data it describes, not in the store: it records what THIS machine has already
// sent, and a copy of the repository somewhere else has sent nothing.
const ledgerPath = (mmaDir) => join(mmaDir, ".zz-migrated.json");
const readLedger = (mmaDir) => {
  try { return JSON.parse(readFileSync(ledgerPath(mmaDir), "utf8")); } catch { return {}; }
};
let ledger, ledgerFile;
const remember = (key, val) => {
  ledger[key] = val;
  if (!DRY) writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + "\n");
};

// ── the body of a migrated node ────────────────────────────────────────────
/** mma kept the prose in `## Context` / `## Consequences` and a one-line `description`, and
 * two thirds of the corpus filled only the description. So the body is whatever is actually
 * there, plus a provenance line — because a node that turns up in a search two years from now
 * should say where it came from without anybody having to remember there was an import. */
function nodeBody(n, repo, initiative) {
  const parts = [];
  if (n.description) parts.push(n.description.trim());
  if (n.body) parts.push(n.body.trim());
  if (!parts.length) parts.push(`(The mma journal recorded this node with a title and no body.)`);
  const rel = n.links.filter((l) => l.target);
  if (rel.length) {
    parts.push(`**Related in the mma journal:** ` +
      rel.map((l) => `${l.type} ${l.target}`).join(", ") +
      ` — those ids are mma's; the tag \`mma-${slug(repo)}-<id>\` finds each one here.`);
  }
  parts.push(`---\n\n*Migrated from the mma journal of \`${repo}\`, node ${n.mmaId}` +
    `${n.timestamp ? `, recorded ${n.timestamp.slice(0, 10)}` : ""}. ` +
    `The material it came from is in \`${initiative}\`.*`);
  return parts.join("\n\n");
}

function exploreDoc(s, initiative) {
  const kinds = {};
  for (const x of s.sources) kinds[x.kind] = (kinds[x.kind] ?? 0) + 1;
  const dates = s.sources.map((x) => x.date).filter(Boolean).sort();
  return [
    "# " + `The mma archive of ${s.repo}`,
    "",
    "## Background",
    "",
    `\`${s.repo}\` ran on mma, which kept its working history in a \`.mma/\` directory in the ` +
    "repository: specs and plans, the explorations before them, the audits and verifications " +
    "after, and a journal of what the work taught. This initiative is that history, brought " +
    "over whole so it can be searched, cited and built on here.",
    "",
    "## Current state",
    "",
    `${s.sources.length} historical documents are attached as sources` +
    (dates.length ? `, spanning ${dates[0]} to ${dates[dates.length - 1]}` : "") + ":",
    "",
    ...Object.entries(kinds).sort().map(([k, n]) => `- ${n} × ${k}`),
    "",
    `${s.nodes.length} journal nodes were minted into the team's knowledge base, each citing ` +
    "this initiative as its evidence.",
    "",
    "## Rough direction",
    "",
    "Nothing here is work in flight. It is a reference: the sources are immutable by design, " +
    "and this initiative exists to give the migrated knowledge somewhere real to point. New " +
    "work starts as its own initiative and cites what it finds here.",
    "",
  ].join("\n");
}

// ── the run ────────────────────────────────────────────────────────────────
async function main() {
  const s = survey(repoRoot);
  ledgerFile = ledgerPath(s.mmaDir);
  ledger = readLedger(s.mmaDir);

  const tok = token();
  const base = gateway();
  const core = new Door(base, "/core/mcp", tok, "zz-migrate");
  const me = JSON.parse(await core.call("get_my_info", {}));
  const today = me.today;
  const initiative = ledger.__initiative || `${today}-mma-archive-${slug(s.repo)}`;

  console.log(`Repository   ${repoRoot}`);
  console.log(`Platform     ${base} — team ${me.team}, as ${me.email}`);
  console.log(`Initiative   ${initiative}`);
  console.log(`To import    ${s.sources.length} sources, ${s.nodes.filter((n) => n.status === "adopted" || n.status === "superseded").length} journal nodes` +
              (LIMIT ? `  (--limit ${LIMIT})` : ""));
  const done = Object.keys(ledger).filter((k) => !k.startsWith("__")).length;
  if (done) console.log(`Already sent ${done} — those are skipped`);
  if (DRY) console.log(`\nDRY RUN — deciding everything, sending nothing.\n`);
  else console.log("");

  // ONLY WHAT THIS PLATFORM CAN SAY. mma's journal has four statuses; a zz node has two
  // states, adopted and superseded-by-another-node. A `dropped` or `inconclusive` node
  // imported anyway would be minted `adopted` — the platform stamps that on every node it
  // writes — so "we tried this and dropped it" would come back out of search_knowledge as
  // current practice. That is worse than not importing it: it is the record saying the
  // opposite of what happened.
  //
  // Neither corpus this was built against has one, which is exactly why it is filtered
  // rather than trusted: the schema allows both, and the next repository is not these two.
  const IMPORTABLE = new Set(["adopted", "superseded"]);
  const untaken = s.nodes.filter((n) => !IMPORTABLE.has(n.status));
  const importable = s.nodes.filter((n) => IMPORTABLE.has(n.status));
  if (untaken.length) {
    const by = {};
    for (const n of untaken) by[n.status] = (by[n.status] ?? 0) + 1;
    console.log(`Not imported ${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(", ")} — ` +
                `this platform has no such state, and importing them would stamp them adopted.`);
  }

  const sources = LIMIT ? s.sources.slice(0, LIMIT) : s.sources;
  const nodes = LIMIT ? importable.slice(0, LIMIT) : importable;

  // 1 ── the archive initiative. It has to exist before anything can cite it: evidence is
  // checked against the folder on disk, not merely against being non-empty.
  if (!ledger.__initiative) {
    console.log(`Creating ${initiative}/explore.md`);
    if (!DRY) {
      await core.call("write_file", {
        path: `${initiative}/explore.md`,
        content: exploreDoc(s, initiative),
        flow: FLOW,
        title: `The mma archive of ${s.repo}`,
        tags: ["mma-import", `mma-${slug(s.repo)}`],
      });
      remember("__initiative", initiative);
    }
  } else {
    console.log(`Initiative already created.`);
  }

  // 2 ── the historical corpus, as sources. Oldest first, so the archive reads as a timeline.
  let sent = 0, skipped = 0, failed = [];
  for (const src of sources) {
    const key = `source:${src.key}`;
    if (ledger[key]) { skipped++; continue; }
    tick(`  sources  ${sent + skipped + failed.length + 1}/${sources.length}  ${src.key}`);
    if (DRY) { sent++; continue; }
    try {
      await core.call("add_source", { initiative, title: src.title, content: src.content });
      remember(key, true); sent++;
    } catch (e) { failed.push([src.key, e.message]); }
  }
  endTick(`  sources  ${sent} sent, ${skipped} already there, ${failed.length} failed`);

  // 3 ── the journal. In id order, because step 4 cannot supersede a node that is not minted.
  const minted = { ...(ledger.__ids ?? {}) };
  let nSent = 0, nSkipped = 0;
  const nFailed = [];
  for (const n of nodes) {
    const key = `node:${n.mmaId}`;
    if (ledger[key]) { nSkipped++; minted[n.mmaId] ??= ledger[key]; continue; }
    tick(`  journal  ${nSent + nSkipped + nFailed.length + 1}/${nodes.length}  ${n.mmaId} ${n.title}`);
    if (DRY) { nSent++; continue; }
    try {
      // Tags carry the origin so a migrated node can be found as one, and so a second run of
      // this import can be told apart from a node somebody wrote by hand. A colon form
      // (`mma:0001`) is refused — the platform reads `kind:name` as a registry key and `mma`
      // is not one of its kinds — so the origin is spelled out flat.
      const tags = [...new Set([
        ...n.tags.map(slug).filter(Boolean),
        ...(n.topic ? [slug(n.topic)] : []),
        "mma-import", `mma-${slug(s.repo)}-${n.mmaId}`,
      ])].filter((t) => /^[a-z0-9][a-z0-9._-]*$/.test(t)).slice(0, 20);
      const out = await core.call("knowledge_add", {
        title: n.title, type: n.type, scope: "team",
        body: nodeBody(n, s.repo, initiative),
        evidence: [initiative], tags,
      });
      const id = /journal node (\d+) created/.exec(out)?.[1];
      minted[n.mmaId] = id ?? true;
      remember(key, id ?? true);
      ledger.__ids = minted; remember("__ids", minted);
      nSent++;
    } catch (e) { nFailed.push([n.mmaId, e.message]); }
  }
  endTick(`  journal  ${nSent} minted, ${nSkipped} already there, ${nFailed.length} failed`);

  // 4 ── the supersede edges, once both ends exist. mma's other edge types (relates, refines,
  // depends-on, contradicts, parent) have no counterpart here and are written into the body
  // rather than invented into a graph the platform does not have.
  let sup = 0;
  const supFailed = [];
  for (const n of nodes.filter((x) => x.status === "superseded" && x.supersededBy)) {
    const key = `supersede:${n.mmaId}`;
    if (ledger[key]) continue;
    // A dry run mints nothing, so neither end has a platform id yet. Counting that as a
    // failure reported nine problems for a run that had none and exited non-zero on a
    // rehearsal that went perfectly.
    if (DRY) { sup++; continue; }
    const oldId = minted[n.mmaId], newId = minted[n.supersededBy];
    if (typeof oldId !== "string" || typeof newId !== "string") {
      supFailed.push([n.mmaId, `it supersedes ${n.supersededBy}, which is not among the nodes ` +
        "imported here — run without --limit so both ends exist"]);
      continue;
    }
    try {
      // `shelf` because ids are allocated per shelf and both start at 0001, so a minted team
      // node's number usually also names a platform node — and a bare pair is refused as
      // ambiguous. Everything this import mints is `scope: "team"`, so the shelf is never in
      // doubt on this side.
      await core.call("knowledge_supersede", { old_id: oldId, new_id: newId, shelf: "team" });
      remember(key, true); sup++;
    } catch (e) { supFailed.push([n.mmaId, e.message]); }
  }
  console.log(`  history  ${sup} supersede edges${supFailed.length ? `, ${supFailed.length} not made` : ""}`);

  // 5 ── say plainly that the archive stays open.
  //
  // There is no archived state on this platform. `close` writes the outcome onto the flow's
  // CLOSING document, every flow that declares one gates it, and an imported archive has no
  // approvals because nobody approved anything — signing that gate to tidy a listing is the
  // one thing the gates exist to prevent. So the archive sits in `initiative_status()` beside
  // real work, and the only honest thing to do about it is say so here rather than let it be
  // discovered later as a mystery entry from 2026.
  console.log(`  open     ${initiative} stays OPEN — this platform has no archived state, and ` +
              `closing it\n           would mean signing a gate nobody signed. It will appear ` +
              `in initiative_status().`);

  // ── what happened ────────────────────────────────────────────────────────
  const problems = [...failed, ...nFailed, ...supFailed];
  console.log("");
  if (problems.length) {
    console.log(`${problems.length} did not go over:`);
    for (const [what, why] of problems.slice(0, 15)) console.log(`  ${what}: ${why.split("\n")[0].slice(0, 160)}`);
    if (problems.length > 15) console.log(`  ... and ${problems.length - 15} more`);
    console.log(`\nEverything that DID go over is recorded, so running this again sends only ` +
                `what is missing.`);
    process.exit(1);
  }
  if (DRY) {
    console.log(`Nothing was sent. Run without --dry-run to import.`);
    return;
  }
  console.log(`Done. ${initiative} holds the archive; ${nSent + nSkipped} journal nodes are in ` +
              `the team knowledge base.`);
  console.log(`Search it with search_knowledge, or find everything this import brought over ` +
              `with the tag \`mma-import\`.`);
}

main().catch((e) => { console.error(`\n${e.message}`); process.exit(1); });
