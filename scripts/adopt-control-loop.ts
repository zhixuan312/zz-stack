#!/usr/bin/env node
/**
 * adopt-control-loop.ts — bring every existing initiative under the control loop.
 *
 * WHY EVERY INITIATIVE AND NOT ONLY NEW ONES. Enrolling only initiatives opened after the
 * switch would leave the old ones governed by the nine hand-written guards they were opened
 * under, and the platform would have two authorities on "may this close" while even one
 * of them stayed open. That is the duplication this whole adoption exists to remove rather
 * than add, and the stakeholder said so in as many words: 旧的应该 migrate 去新的格式与规则.
 *
 * WHAT IT FABRICATES: NOTHING.
 *
 * Evidence is derived only from facts the platform already holds — a document exists at the
 * path a stage declares it produces; an approval is recorded on it; a source supports the
 * document an audit stage supports. These are read out of `zz.doc` and the initiative store.
 * Not one of them is invented here.
 *
 * Where a step genuinely never happened, this records a WAIVER naming that fact, and writes a
 * stand-in document that says plainly what it is. The stand-in fills the FORM — the flow's
 * shape is complete and a reader can see the slot — and does not fill the CONTENT: it claims
 * no findings, and nothing reads it as an audit that occurred. The kernel is never told the
 * evidence exists; it goes on reporting the requirement unmet, and the waiver sits beside
 * that answer saying who accepted the gap and why.
 *
 * The alternative that was rejected, and the reason: recording the waiver AS evidence of the
 * missing kind would turn the verdict green in one line. It would also put an entry in the
 * log saying an audit exists when none happened, and a record that says a stage ran when it
 * did not is what this platform's own FR-28 and FR-29 forbid.
 *
 * MEASURED BEFORE IT WAS WRITTEN, against production: 27 sdlc-flow initiatives, of which 2
 * satisfy all seven declared steps and 24 lack a spec-audit or a plan-audit. 16 are closed
 * and 11 are open; 10 of the open ones would be unable to claim `close:initiative` on the
 * declaration alone. Those ten are why the waiver exists. They can still abandon at any time
 * — stopping never needed a grant — but they should not have to lie to finish.
 *
 *   node scripts/adopt-control-loop.ts --dry     # report what it would do, change nothing
 *   node scripts/adopt-control-loop.ts --apply   # do it
 *
 * DRY BY DEFAULT. A migration that runs when somebody meant to look at it is a migration
 * that runs at the wrong time, and this one writes to a store holding 41 initiatives.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const APPLY = process.argv.includes("--apply");
const DRY = !APPLY;

/** The stand-in's body. It is the whole content, and it is deliberately not audit-shaped:
 *  a reader arriving at this file must not be able to mistake it for a round that happened. */
const STAND_IN = (step: string, initiative: string, when: string) =>
  `# ${step} — no round was performed\n\n` +
  `**This is a stand-in, not a record of work.** No ${step} round was run for ` +
  `\`${initiative}\`. This file exists so the gap is visible in the flow rather than inferred ` +
  `from an absence, and so the initiative can be migrated under the control loop without ` +
  `anybody writing findings that were never found.\n\n` +
  `It carries no findings, no verdict and no evidence. The requirement it stands in for is ` +
  `discharged by a recorded waiver naming this fact, not by this document — the control loop ` +
  `goes on reporting that requirement unmet, which is true.\n\n` +
  `Recorded ${when} during the migration that brought existing initiatives under the ` +
  `declared procedure.\n`;

interface Row { readonly [k: string]: string | null }

/** The flow's stages as the manifest declares them, normalised to the two fields this script
 *  asks for. Reads the catalogue on disk — the same file the service reads — so there is one
 *  declaration of a flow's shape and this is not it. */
function stagesOf(flow: string): Array<{ step: string; produces: string; supports?: string }> {
  const dir = process.env.ZZ_CATALOG_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "catalog");
  for (const pack of ["sdlc", "zz"]) {
    const file = join(dir, pack, flow, "flow.json");
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, "utf8")) as
      { stages?: Array<{ name?: string; produces?: string; supports?: string }> };
    return (manifest.stages ?? []).map((st) =>
      ({ step: st.name ?? "", produces: st.produces ?? "", supports: st.supports }));
  }
  return [];
}

/** One derived evidence entry. `about` names the document the fact is about, and `note` says
 *  where the fact came from — so a reader of the log can tell a migrated entry from one the
 *  platform recorded live, without having to date it. */
async function record(pool: pg.Pool, runId: string, step: string, kind: string,
                      initiative: string, document: string): Promise<void> {
  // THE SAME BACK-REFERENCE THE LIVE PATH BUILDS, and it has to be byte-identical or a
  // migrated run and a live one would be judged by different graphs. A completion rule
  // carrying `about` is satisfied only by an entry whose `about` is the ID of an entry of
  // the named kind, so an approval or an audit points at `doc:<document>` and nothing else.
  // INITIATIVE-RELATIVE, LIKE THE LIVE PATH, and this is the third defect of this exact
  // shape tonight. The flow's manifest names a document `spec.md`; the platform records it
  // as `<initiative>/spec.md`. Writing `doc:spec.md` here produced a graph that was
  // internally consistent and therefore SATISFIED ITS OWN RULES — so nothing failed, nothing
  // was refused, and an initiative with both live and migrated evidence quietly carried two
  // parallel graphs in two namespaces. Found by migrating an initiative that had just been
  // driven through the real doors and reading both sets of rows side by side.
  const path = `${initiative}/${document}`;
  const documentEntry = `doc:${path}`;
  // IDEMPOTENT, because a migration that cannot be re-run is a migration nobody dares fix.
  // `zz.control_evidence` is append-only by design and carries no unique key — a fact is a
  // fact and the log is the history — so the guard is here: an entry this run would add and
  // that is already on the run is a fact already recorded, not a second one.
  // AN AUDIT IS SKIPPED IF THE STEP ALREADY HAS ONE, not merely if this exact id is present.
  // The live path keys an audit on the SOURCE that carried it — one row per round, which is
  // right — while this derives one from the audited DOCUMENT, because a migrated initiative
  // has no source to name. Deduplicating on the id alone would add a third row to a step that
  // already had two real ones, and a reader counting rounds would be told a round happened
  // that nobody ran. For a document or an approval the id IS the identity, so that case keeps
  // the narrower guard.
  const guard = kind === "audit"
    ? `where not exists (select 1 from zz.control_evidence
                          where run_id = $1 and step_id = $3 and kind = 'audit')`
    : `where not exists (select 1 from zz.control_evidence where run_id = $1 and entry_id = $2)`;
  await pool.query(
    `insert into zz.control_evidence
       (run_id, entry_id, step_id, kind, about, note, recorded_at, recorded_by)
     select $1,$2,$3,$4,$5,$6, now(), 'adopt-control-loop.ts'
      ${guard}`,
    [runId, kind === "document" ? documentEntry : `${kind}:${path}`, step, kind,
     kind === "document" ? path : documentEntry,
     "derived during migration from a fact the platform already held"]);
}

async function main(): Promise<void> {
  const url = process.env.TEAM_DB_URL ?? process.env.ZZ_DB_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("  REFUSED — no database URL in TEAM_DB_URL, ZZ_DB_URL or DATABASE_URL");
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 10_000 });

  // EVERY INITIATIVE THAT DECLARES A FLOW, with what the store already knows about it. The
  // query asks for facts, not verdicts: which documents exist, which are approved. What that
  // means for a step is decided against the flow's manifest, not here.
  const { rows } = await pool.query(`
    -- THE FLOW IS A PROPERTY OF THE INITIATIVE, NOT OF EVERY ROW IN IT. A source carries no
    -- a flow stamp — the envelope puts it on documents the flow declares, and a source is not one
    -- — so filtering every row on flow = 'sdlc-flow' drops every source before the grouping
    -- ever sees it. Written that way, this counted zero source-form audits and would have
    -- waived every audit round recorded the way the live path records them. Found by running
    -- it against a database where an audit had just been added through the real door.
    select initiative, max(flow) filter (where flow is not null and flow <> '') as flow,
           array_agg(distinct split_part(path,'/',array_length(string_to_array(path,'/'),1))) as docs,
           array_agg(distinct split_part(path,'/',array_length(string_to_array(path,'/'),1)))
             filter (where status = 'approved') as approved,
           -- BOTH FORMS OF AUDIT EVIDENCE, because this platform has produced both. Historically
           -- an audit round wrote a spec-audit.md DOCUMENT; the flow's manifest declares the
           -- audit stages as producing a SOURCE that supports the document they audited, and the
           -- live path records it that way. Counting only one form would waive audits that
           -- happened — and which form it missed would depend on when the initiative ran.
           array_agg(distinct supports) filter (where type = 'source' and supports is not null)
             as supported,
           bool_or(outcome is not null or closed_by is not null) as closed,
           min(team_slug) as team
      from zz.doc
     where initiative is not null
     group by initiative
    having max(flow) filter (where flow is not null and flow <> '') is not null
     order by initiative`);

  console.log(`  ${rows.length} initiative(s) declare a flow`);
  if (DRY) console.log("  DRY RUN — nothing will be written. Pass --apply to act.\n");

  let runs = 0, evidence = 0, waivers = 0, standIns = 0, ungoverned = 0;
  const owed: string[] = [];

  /** The digest sdlc-flow was approved under. Read from the allowlist the service ships, so a
   *  run records what governed it rather than what a later release happens to carry. */
  const DIGEST = "25bc5ab68ac111e75b81cbb470584f2bf728c3a08efd48740d6d4f7b85839de0";
  const WHEN = new Date().toISOString().slice(0, 10);

  for (const r of rows as Row[]) {
    const flow = String(r.flow);
    // A flow with no reviewed module is NOT GOVERNED, and that is an answer rather than a
    // gap. zz-plugin-eval reaches this and is skipped; nothing about it changes, and no run
    // is opened, so a later caller can still tell "not enrolled" from "enrolled and unmet".
    if (flow !== "sdlc-flow") { ungoverned += 1; continue; }

    const docs = new Set((r.docs as unknown as string[] | null) ?? []);
    const approved = new Set((r.approved as unknown as string[] | null) ?? []);
    const supported = new Set((r.supported as unknown as string[] | null) ?? []);
    // THE STEPS COME FROM THE FLOW'S MANIFEST, NOT FROM A TABLE IN THIS FILE. An earlier
    // draft of this script listed the seven stages inline, which would have been a second
    // declaration of something `catalog/sdlc/sdlc-flow/flow.json` already declares — the
    // exact duplication the rest of this adoption exists to remove, committed by the script
    // doing the removing. Read from the manifest, a renamed or added stage follows without
    // an edit here, and a stage this script cannot match stops crediting rather than
    // crediting the wrong step.
    const steps = stagesOf(flow);
    if (!steps.length) {
      console.error(`  REFUSED — ${flow} declares no stages; nothing can be derived for ` +
                    `${r.initiative} without guessing what its steps are`);
      process.exit(3);
    }

    runs += 1;
    let runId: string | null = null;
    if (APPLY) {
      const ins = await pool.query(
        `insert into zz.control_run
           (team_slug, initiative, module_id, module_digest, subject, profile, started_at, started_by)
         values ($1,$2,'sdlc-flow',$3,$2,'[]'::jsonb, now(), $4)
         on conflict (team_slug, initiative) do update set team_slug = excluded.team_slug
         returning id`,
        [r.team, r.initiative, DIGEST, "adopt-control-loop.ts"]);
      runId = ins.rows[0]?.id ?? null;
    }

    for (const s of steps) {
      if (!s.step || s.produces === "nothing" || !s.produces) continue;
      if (s.produces === "source") {
        // An audit round evidences itself with a source supporting the document it audited.
        // The store records that as the audit document sitting beside the one it audited, so
        // its presence is the fact this asks for.
        const auditDoc = s.supports === "spec.md" ? "spec-audit.md" : "plan-audit.md";
        if (docs.has(auditDoc) || (s.supports !== undefined && supported.has(s.supports))) {
          evidence += 1;
          if (APPLY && runId) await record(pool, runId, s.step, "audit", String(r.initiative), s.supports ?? auditDoc);
          continue;
        }
        waivers += 1; standIns += 1;
        // THE WAIVER IS THE AUTHORITATIVE RECORD; the stand-in document is for a human reader.
        // They are split because they go to different places: the waiver is this migration's
        // own table, and a document belongs to the platform's document path with the envelope
        // that path owns. Writing a document straight into the store here would produce one
        // the platform did not stamp, which is the "third source" of envelope fields this
        // platform closed. So the waiver lands now and names the document it is owed, and
        // `--stand-ins` writes them through the proper door afterwards.
        owed.push(`${r.initiative}/${auditDoc}`);
        if (APPLY && runId) {
          await pool.query(
            `insert into zz.control_waiver (run_id, step_id, kind, ground, recorded_at, recorded_by)
             select $1,$2,'audit',$3, now(), 'adopt-control-loop.ts'
              where not exists (select 1 from zz.control_waiver
                                 where run_id = $1 and step_id = $2 and kind = 'audit')`,
            [runId, s.step,
             `no ${s.step} round was performed and none will now be — this initiative predates ` +
             `automatic control, migrated ${WHEN}. A stand-in document records the gap; it is ` +
             `not evidence, and the requirement stays unmet in the engine's own answer.`]);
        }
        continue;
      }
      if (docs.has(s.produces)) {
        evidence += 1;
        if (APPLY && runId) await record(pool, runId, s.step, "document", String(r.initiative), s.produces);
      }
      if (approved.has(s.produces)) {
        evidence += 1;
        if (APPLY && runId) await record(pool, runId, s.step, "approval", String(r.initiative), s.produces);
      }
    }
  }

  console.log(`\n  runs to open       ${runs}`);
  console.log(`  evidence entries   ${evidence}   (derived from documents and approvals already recorded)`);
  console.log(`  waivers            ${waivers}   (each names the ground; none fabricates evidence)`);
  console.log(`  stand-in documents ${standIns}   (form, not content)`);
  console.log(`  not governed       ${ungoverned}   (flow has no reviewed module — an answer, not a gap)`);
  if (owed.length) {
    console.log(`\n  ${owed.length} stand-in document(s) owed, to be written through the ` +
      `platform's own document path rather than into the store behind it:`);
    for (const o of owed.slice(0, 6)) console.log(`      ${o}`);
    if (owed.length > 6) console.log(`      … and ${owed.length - 6} more`);
    console.log(`  Each will carry, verbatim:\n` +
      STAND_IN("the audit stage", "the initiative", WHEN).split("\n").slice(0, 3).map((l) => `      ${l}`).join("\n"));
  }
  if (DRY) console.log("\n  DRY RUN — nothing was written.");
  await pool.end();
}

main().catch((e: unknown) => {
  console.error(`  FAILED — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
