/**
 * LAYER 6 — is the data behind the platform the shape this checkout expects?
 *
 * Last, because it is the layer whose disagreements are least likely to be the CAUSE of
 * anything else and most likely to be the consequence. A migration that never applied does not
 * take a door down; it takes one query down, weeks later, for one caller.
 *
 * Both probes read through the host's own configuration. `-U zz -d zz` was written here as a
 * literal while .env.example documents POSTGRES_USER and POSTGRES_DB as settable — on a
 * deployment that sets either, the probe fails, and this probe is what a release rolls back
 * on: a good version undone by a name the script guessed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REMOTE, root, run, ssh } from "../../deployment.ts";
import { layer, probe } from "../run.ts";

layer("data", "is the data the shape this checkout expects", ["services/gateway/migrations", "catalog"]);

/** psql on the host, through compose, with the role and database read rather than typed. */
const psql = (sql: string): string => ssh(
  `cd ${REMOTE}/deploy && ` +
  `U=$(grep -oP '(?<=^POSTGRES_USER=).*' .env || echo zz) && ` +
  `D=$(grep -oP '(?<=^POSTGRES_DB=).*' .env || echo zz) && ` +
  `docker compose exec -T postgres psql -U "$U" -d "$D" -tAc ${JSON.stringify(sql)} 2>/dev/null || true`);

probe("every migration is applied, and every applied migration still exists", () => {
  const files = run("bash", ["-c", `ls ${root}/services/gateway/migrations/*.sql | xargs -n1 basename`])
    .split("\n").filter(Boolean);
  const applied = psql("select name from zz.schema_migration").split("\n").map((x) => x.trim()).filter(Boolean);
  if (!applied.length) throw new Error("could not read zz.schema_migration on the host");
  // BY NAME, BOTH DIRECTIONS — which the sentence above always claimed and a count comparison
  // never did. `applied >= files` passed a deleted migration (its row still counted), passed a
  // renamed one (old row plus new file, totals unchanged), and could only ever notice a file
  // nobody had run yet.
  const inDb = new Set(applied), onDisk = new Set(files);
  const unapplied = files.filter((f) => !inDb.has(f));
  const orphaned = applied.filter((a) => !onDisk.has(a));

  // A MIGRATION MAY BE UNAPPLIED ON PURPOSE, and this probe used to call that a disagreement.
  //
  // `services/gateway/src/db.ts` DEFERS a migration declaring `-- requires-extension: X` when
  // this cluster cannot supply X — skipped, and deliberately NOT recorded as applied, because
  // a migration attempted where its extension is absent throws, rolls back, un-sets the pool
  // and rethrows, and the gateway starts anyway: the platform serving with no database while
  // reporting itself healthy. Migration 070 needs pg_textsearch, which arrives with a
  // PostgreSQL 17 image this project has not built yet.
  //
  // THIS PROBE IS STRICTER THAN AN EXEMPTION, because unlike the release's offline checks it
  // is talking to the actual database. It does not take the directive's word for anything: it
  // ASKS the cluster what it offers, and a migration whose declared extension IS available and
  // which still has not run is a real disagreement — exactly the case where the deferral has
  // stopped being a deferral and become a migration nobody noticed failing.
  const stillUnapplied: string[] = [];
  const deferredHere: string[] = [];
  const available = new Set(psql("select name from pg_available_extensions")
    .split("\n").map((x) => x.trim()).filter(Boolean));
  for (const file of unapplied) {
    const sql = readFileSync(join(root, "services/gateway/migrations", file), "utf8");
    const needs = [...sql.matchAll(/^--\s*requires-extension:\s*([a-z0-9_]+)\s*$/gim)].map((m) => m[1]);
    const missing = needs.filter((n) => !available.has(n));
    if (needs.length && missing.length && available.size) deferredHere.push(`${file} (needs ${missing.join(" and ")})`);
    else stillUnapplied.push(file);
  }
  if (stillUnapplied.length) return `on disk but never applied: ${stillUnapplied.join(", ")}`;
  if (orphaned.length) return `applied but no longer in this checkout: ${orphaned.join(", ")}`;
  // Reported, never silent: an unapplied migration is a fact an operator should be told, even
  // when it is the correct one. It is the difference between this platform's schema and the
  // schema this checkout describes.
  if (deferredHere.length) {
    console.log(`      deferred, correctly — this cluster offers no such extension: ${deferredHere.join(", ")}`);
  }
  return null;
});

// The registry is written from the catalog by the release's own deploy step, so a catalog that
// grew a skill without a release leaves the two disagreeing — and the symptom is a skill an
// agent cannot load, which looks like the agent's fault.
probe("the skill registry is not behind the catalog", () => {
  const onDisk = Number(run("bash", ["-c",
    `find ${root}/catalog -name SKILL.md | wc -l`]).trim());
  if (!onDisk) return "this checkout's catalog holds no SKILL.md at all — the doctor is reading nothing";
  const rows = Number((psql("select count(*) from zz.skill").trim() || "0"));
  if (!rows) throw new Error("could not count zz.skill on the host");
  return rows >= onDisk ? null
    : `the catalog ships ${onDisk} skills and the registry holds ${rows} row(s) — the deploy step's ` +
      `registry update has not run for what is on disk`;
});

// EVERY RUN NAMES A VERSION, or the evaluation track is reading noise.
//
// zz.run is DERIVED from zz.event by reconcileRuns() on a timer, and it keyed the version on
// zz.event.step_version — a column stamped only when a skill is served whole through
// skill_read, which an installed skill read off disk never is. So every row the
// initiative-bearing insert wrote carried skill_version_id NULL; a NULL cannot match that
// insert's conflict target, because Postgres treats NULLs as distinct; `do update` therefore
// never fired and each pass of the timer appended another copy. The table reached 1791 rows of
// which 1787 were duplicates of two, growing by roughly 950 a day, every one of them with
// events attached by a linkback that matched NULLs deliberately.
//
// Nothing offline could see it. The gate is static and cannot reach a database; tsc cannot see
// inside a template literal; and a table full of rows that look like runs reads, in every
// query, as a healthy table. This is the probe that would have said so on day one, and it is
// here rather than in the gate for exactly that reason.
//
// READ-ONLY, like everything in this file. A null row is reported, never deleted: the cleanup
// is an operator's decision made once, and a doctor that fixed what it found would be a doctor
// nobody could safely run while something was broken.
probe("every run names the skill version it ran", () => {
  const total = Number((psql("select count(*) from zz.run").trim() || "0"));
  const orphan = psql("select count(*) from zz.run where skill_version_id is null").trim();
  if (orphan === "") throw new Error("could not count zz.run on the host");
  const n = Number(orphan);
  if (!n) return null;
  const pct = total ? Math.round((n / total) * 1000) / 10 : 0;
  return `${n} of ${total} zz.run rows (${pct}%) name no skill version. reconcileRuns() cannot ` +
         `dedupe them — a NULL never matches its conflict target — so the timer appends another ` +
         `copy every pass. Delete them once (they are derived, and re-derive from zz.event), ` +
         `and check that the version is resolved by released_at rather than by step_version`;
});

// R13 · A PROBE DELETES WHAT IT CREATES, and the store is where you find out it did not.
//
// `chain-check` opens a fresh initiative on every run and closes it; closing is not deleting.
// Three days of release runs left 58 probe initiatives, 463 documents, 1,882 events and 240 of
// the platform's 350 runs in this store — 54 on the platform's own team and 4 on a real
// person's. `release.ts` sweeps after itself now, and this is what says whether the sweep is
// working, on the one deployment where it matters.
//
// IT IS NOT A GATE CHECK because the gate is offline and this is a fact about DATA. The source
// can be perfect while the store fills up, which is exactly what happened.
probe("no initiative in the store was left behind by a probe", () => {
  const n = psql("select count(*) from zz.initiative where slug like '%chain-check-%'").trim();
  if (n === "") throw new Error("could not count zz.initiative on the host");
  if (n === "0") return null;
  return `${n} initiative(s) named chain-check-* are still in the store. The live chain check ` +
         `opens one per run and release.ts is supposed to purge them afterwards — a count above ` +
         `zero means that sweep did not run, and every measurement taken over this store is ` +
         `being taken over test traffic. scripts/ops/purge-probes.ts removes them.`;
});

// R5 · A STATUS IS A GATE VERDICT, so only a document its flow GATES may carry one.
//
// Whether a document is adjudicated is decided per flow and per document by that flow's
// manifest. The manifests are in this checkout and the documents are on the deployment, so
// this is the one place the two can be compared — and neither half can answer it alone.
//
// `handover.md` is the platform's own, appended gated to every flow that gates anything, so it
// is expected to carry one wherever it appears.
probe("no document carries a status its flow does not gate", () => {
  const gated = new Map<string, boolean>();
  for (const f of run("bash", ["-c", `ls ${root}/catalog/*/*/flow.json`]).split("\n").filter(Boolean)) {
    const m = JSON.parse(readFileSync(f, "utf8")) as
      { name?: string; documents?: { name: string; gate?: boolean }[] };
    for (const d of m.documents ?? []) gated.set(`${m.name ?? ""}/${d.name}`, d.gate === true);
  }
  if (!gated.size) throw new Error("no flow manifest in this checkout declares a document");
  const rows = psql(
    "select flow, regexp_replace(path,'^.*/',''), status from zz.doc " +
    "where status <> '' and path not like '\\_versions/%'").split("\n").filter(Boolean);
  const bad: string[] = [];
  for (const line of rows) {
    const [flow, name, status] = line.split("|");
    if (name === "handover.md") continue;
    const declared = gated.get(`${flow}/${name}`);
    if (declared === undefined) continue;          // a document no manifest here declares
    if (!declared) bad.push(`${flow}/${name} (${status})`);
  }
  if (!bad.length) return null;
  const shown = [...new Set(bad)].slice(0, 6).join(", ");
  return `${bad.length} document(s) carry a status their flow does not gate: ${shown}` +
         `${bad.length > 6 ? ", …" : ""}. A status records that a person agreed; these were ` +
         `never put to anyone. stampEnvelope writes one only where the manifest declares a ` +
         `gate, so rows like these predate that and need their frontmatter corrected and the ` +
         `team reindexed.`;
});

// R11 · ATTRIBUTION IS LOOKED UP — AND THE GATE CAN ONLY SEE THAT IT IS.
//
// The gate asserts telemetry resolves the plugin from the door and never from the caller's
// step trace. That is the mechanism, and a spec audit was right that it is not the property: a
// rewrite can satisfy the grep and leave every row null. Measured before this landed, 194 of
// 3,996 tool calls carried a plugin — 4.9% — while the code that produced them looked correct
// on every reading.
//
// A door IS a plugin's declared server, so a call that arrived on one is attributable by
// construction; the only honest null is a surface no manifest claims, which today is `admin`.
// So this counts what is NOT attributed and excludes that one.
probe("recent tool calls name the plugin whose door they arrived on", () => {
  // THE LAST 200 CALLS, NOT ALL OF THEM, and the bound is the whole design of this probe.
  //
  // Attribution is a property of the code that WROTE a row. Rows written before pluginForDoor
  // landed carry nulls no deploy can fill, and counting them forever reported 94.7% on a
  // deployment where the new path was working perfectly — a check that cannot pass is a check
  // people learn to scroll past. Nor is `plugin_version is not null` a usable boundary: the
  // OLD path set that column too whenever its guess resolved, so it does not mark the change.
  //
  // A count-bounded window needs no timestamp and no marker. It answers the question that
  // matters — is what is running now attributing what it handles — and it corrects itself as
  // the platform is used. Expect it red for a short while after the release that introduced
  // this, while the window still holds rows the old code wrote. That is honest, not a defect.
  //
  // `admin` is excluded: it was a door and is not one now, so no manifest claims it and
  // nothing should invent a plugin for it. That is the one null this platform is entitled to.
  const row = psql(
    "select count(*) || '|' || count(plugin) from (" +
    "  select plugin from zz.event where kind = 'tool_call'" +
    "   and split_part(subject,':',1) <> 'admin' order by ts desc limit 200) r").trim();
  const [totalRaw, withPluginRaw] = row.split("|");
  const total = Number(totalRaw);
  if (!row || Number.isNaN(total)) throw new Error("could not count zz.event on the host");
  if (!total) return null;                       // nothing has been called: nothing to judge
  const missing = total - Number(withPluginRaw);
  if (!missing) return null;
  return `${missing} of the last ${total} tool calls name no plugin. Which plugin a call ` +
         `belongs to is a fact about the DOOR it arrived on — pluginForDoor reads it from the ` +
         `manifest that declares the server — so a null here is not a call that could not be ` +
         `attributed, it is one that was not. Rows the old path wrote keep their nulls and age ` +
         `out of this window; a count that does not FALL with use means the new path is not ` +
         `running.`;
});
