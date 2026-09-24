#!/usr/bin/env node
/**
 * zz-migrate — bring one mma repository's history onto the ZZ platform.
 *
 *   node migrate.js [repo]             # default: the current directory
 *   node migrate.js --dry-run          # decide everything, send nothing
 *   node migrate.js --limit 20         # first N of each kind, to try it on something small
 *
 * `.mma/journal/nodes/*.md` become knowledge nodes; mma's six node types are the platform's six.
 *
 * Everything else historical becomes sources on one archive initiative, not documents: an
 * initiative's documents are envelope-governed and gated, and importing historical plans as
 * documents would mean signing their gates on behalf of people who signed nothing. `source_add` is
 * ungated and immutable.
 *
 * `knowledge_add` refuses a node with no evidence, and an mma journal node cites no initiative.
 * So the import creates one archive initiative per repository first, puts the whole historical
 * corpus in it as sources, and every migrated node cites that.
 *
 * It can be run twice: every send is recorded in `.mma/.zz-migrated.json` the moment it succeeds,
 * so an interrupted import resumes where it stopped.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Door, gateway, token } from "./mcp.js";
import { survey } from "./read-mma.js";
/** A caught value is never typed as an Error — narrow the shape actually being read rather
 *  than assume it. */
function errMessage(e) {
    return typeof e === "object" && e !== null && "message" in e
        ? String(e.message) : String(e);
}
/** Progress on one rewritten line, and nothing at all when this is not a terminal.
 *
 *  `\r` is a cursor move, not a line: piped to a file or read by a harness it is just another
 *  character, so hundreds of progress ticks become a transcript of a four-line result. */
const tick = process.stdout.isTTY
    ? (msg) => process.stdout.write(`\r${msg.padEnd(78).slice(0, 78)}`)
    : () => { };
const endTick = (msg) => console.log(process.stdout.isTTY ? `\r${msg.padEnd(78)}` : msg);
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const value = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const DRY = flag("--dry-run");
const LIMIT = Number(value("--limit", "0")) || 0;
const repoRoot = resolve(argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--limit") || ".");
const FLOW = "sdlc-flow";
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const ledgerPath = (mmaDir) => join(mmaDir, ".zz-migrated.json");
const readLedger = (mmaDir) => {
    try {
        const v = JSON.parse(readFileSync(ledgerPath(mmaDir), "utf8"));
        return typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
    }
    catch {
        return {};
    }
};
let ledger, ledgerFile;
const remember = (key, val) => {
    ledger[key] = val;
    if (!DRY)
        writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + "\n");
};
// ── the body of a migrated node ────────────────────────────────────────────
/** mma kept the prose in `## Context` / `## Consequences` and a one-line `description`, and two
 *  thirds of the corpus filled only the description. The body is whatever is actually there,
 *  plus a provenance line saying where it came from. */
function nodeBody(n, repo, initiative) {
    const parts = [];
    if (n.description)
        parts.push(n.description.trim());
    if (n.body)
        parts.push(n.body.trim());
    if (!parts.length)
        parts.push(`(The mma journal recorded this node with a title and no body.)`);
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
function exploreDoc(s) {
    const kinds = {};
    for (const x of s.sources)
        kinds[x.kind] = (kinds[x.kind] ?? 0) + 1;
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
    const whoRaw = JSON.parse(await core.call("session_whoami", {}));
    const me = typeof whoRaw === "object" && whoRaw !== null ? whoRaw : {};
    const today = me.today;
    const initiative = ledger.__initiative || `${today}-mma-archive-${slug(s.repo)}`;
    console.log(`Repository   ${repoRoot}`);
    console.log(`Platform     ${base} — team ${me.team}, as ${me.email}`);
    console.log(`Initiative   ${initiative}`);
    console.log(`To import    ${s.sources.length} sources, ${s.nodes.filter((n) => n.status === "adopted" || n.status === "superseded").length} journal nodes` +
        (LIMIT ? `  (--limit ${LIMIT})` : ""));
    const done = Object.keys(ledger).filter((k) => !k.startsWith("__")).length;
    if (done)
        console.log(`Already sent ${done} — those are skipped`);
    if (DRY)
        console.log(`\nDRY RUN — deciding everything, sending nothing.\n`);
    else
        console.log("");
    // Only what this platform can say. mma's journal has four statuses; a zz node has two, adopted
    // and superseded-by-another-node. A `dropped` or `inconclusive` node imported anyway would be
    // minted `adopted` — the platform stamps that on every node it writes — so "we tried this and
    // dropped it" would come back out of knowledge_search as current practice. Filtered rather than
    // trusted, because the schema allows both.
    const IMPORTABLE = new Set(["adopted", "superseded"]);
    const untaken = s.nodes.filter((n) => !IMPORTABLE.has(n.status));
    const importable = s.nodes.filter((n) => IMPORTABLE.has(n.status));
    if (untaken.length) {
        const by = {};
        for (const n of untaken)
            by[n.status] = (by[n.status] ?? 0) + 1;
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
            await core.call("document_write", {
                path: `${initiative}/explore.md`,
                content: exploreDoc(s),
                flow: FLOW,
                title: `The mma archive of ${s.repo}`,
                tags: ["mma-import", `mma-${slug(s.repo)}`],
            });
            remember("__initiative", initiative);
        }
    }
    else {
        console.log(`Initiative already created.`);
    }
    // 2 ── the historical corpus, as sources. Oldest first, so the archive reads as a timeline.
    let sent = 0, skipped = 0;
    const failed = [];
    for (const src of sources) {
        const key = `source:${src.key}`;
        if (ledger[key]) {
            skipped++;
            continue;
        }
        tick(`  sources  ${sent + skipped + failed.length + 1}/${sources.length}  ${src.key}`);
        if (DRY) {
            sent++;
            continue;
        }
        try {
            await core.call("source_add", { initiative, title: src.title, content: src.content });
            remember(key, true);
            sent++;
        }
        catch (e) {
            failed.push([src.key, errMessage(e)]);
        }
    }
    endTick(`  sources  ${sent} sent, ${skipped} already there, ${failed.length} failed`);
    // 3 ── the journal. In id order, because step 4 cannot supersede a node that is not minted.
    const minted = { ...(ledger.__ids ?? {}) };
    let nSent = 0, nSkipped = 0;
    const nFailed = [];
    for (const n of nodes) {
        const key = `node:${n.mmaId}`;
        const already = ledger[key];
        if (already) {
            nSkipped++;
            minted[n.mmaId] ??= (typeof already === "string" || typeof already === "boolean") ? already : true;
            continue;
        }
        tick(`  journal  ${nSent + nSkipped + nFailed.length + 1}/${nodes.length}  ${n.mmaId} ${n.title}`);
        if (DRY) {
            nSent++;
            continue;
        }
        try {
            // Tags carry the origin so a migrated node can be found as one, and so a second run can be
            // told apart from a node somebody wrote by hand. A colon form (`mma:0001`) is refused — the
            // platform reads `kind:name` as a registry key — so the origin is spelled out flat.
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
            ledger.__ids = minted;
            remember("__ids", minted);
            nSent++;
        }
        catch (e) {
            nFailed.push([n.mmaId, errMessage(e)]);
        }
    }
    endTick(`  journal  ${nSent} minted, ${nSkipped} already there, ${nFailed.length} failed`);
    // 4 ── the supersede edges, once both ends exist. mma's other edge types (relates, refines,
    // depends-on, contradicts, parent) have no counterpart here and are written into the body
    // rather than invented into a graph the platform does not have.
    let sup = 0;
    const supFailed = [];
    for (const n of nodes.filter((x) => x.status === "superseded" && x.supersededBy)) {
        const key = `supersede:${n.mmaId}`;
        if (ledger[key])
            continue;
        // A dry run mints nothing, so neither end has a platform id yet; counting that as a failure
        // reports problems for a rehearsal that went perfectly.
        if (DRY) {
            sup++;
            continue;
        }
        const oldId = minted[n.mmaId], newId = minted[n.supersededBy];
        if (typeof oldId !== "string" || typeof newId !== "string") {
            supFailed.push([n.mmaId, `it supersedes ${n.supersededBy}, which is not among the nodes ` +
                    "imported here — run without --limit so both ends exist"]);
            continue;
        }
        try {
            // `shelf` because ids are allocated per shelf and both start at 0001, so a minted team
            // node's number usually also names a platform node, and a bare pair is refused as
            // ambiguous. Everything this import mints is `scope: "team"`.
            await core.call("knowledge_supersede", { old_id: oldId, new_id: newId, shelf: "team" });
            remember(key, true);
            sup++;
        }
        catch (e) {
            supFailed.push([n.mmaId, errMessage(e)]);
        }
    }
    console.log(`  history  ${sup} supersede edges${supFailed.length ? `, ${supFailed.length} not made` : ""}`);
    // 5 ── say plainly that the archive stays open.
    //
    // There is no archived state on this platform. `initiative_close` writes the outcome onto the
    // flow's closing document, every flow that declares one gates it, and an imported archive has
    // no approvals. So the archive sits in `initiative_status()` beside real work, and this says so
    // rather than letting it be discovered later as a mystery entry.
    console.log(`  open     ${initiative} stays OPEN — this platform has no archived state, and ` +
        `closing it\n           would mean signing a gate nobody signed. It will appear ` +
        `in initiative_status().`);
    // ── what happened ────────────────────────────────────────────────────────
    const problems = [...failed, ...nFailed, ...supFailed];
    console.log("");
    if (problems.length) {
        console.log(`${problems.length} did not go over:`);
        for (const [what, why] of problems.slice(0, 15))
            console.log(`  ${what}: ${why.split("\n")[0].slice(0, 160)}`);
        if (problems.length > 15)
            console.log(`  ... and ${problems.length - 15} more`);
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
    console.log(`Search it with knowledge_search, or find everything this import brought over ` +
        `with the tag \`mma-import\`.`);
}
main().catch((e) => { console.error(`\n${errMessage(e)}`); process.exit(1); });
