/**
 * Layer 6 — is the data behind the platform the shape this checkout expects?
 *
 * Last, because its disagreements are least likely to be the cause of anything else and most likely
 * to be the consequence: a migration that never applied does not take a door down, it takes one
 * query down weeks later, for one caller.
 *
 * Both probes read the database user and name through the host's own configuration rather than as
 * literals — .env.example documents POSTGRES_USER and POSTGRES_DB as settable, and this probe is
 * what a release rolls back on.
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
  // By name, both directions. `applied >= files` passes a deleted migration (its row still counts)
  // and a renamed one (old row plus new file, totals unchanged), and can only ever notice a file
  // nobody has run yet.
  const inDb = new Set(applied), onDisk = new Set(files);
  const unapplied = files.filter((f) => !inDb.has(f));
  // COUPLED: `-- absorbs: <file>` lines in a migration name the files it replaced (001_init.sql
  // holds the squash). A deployment that ran those files keeps their rows, and each one is covered
  // by the file that absorbed it.
  const absorbed = new Set(files.flatMap((f) =>
    [...readFileSync(join(root, "services/gateway/migrations", f), "utf8")
      .matchAll(/^--\s*absorbs:\s*(\S+)\s*$/gm)].map((m) => m[1])));
  const orphaned = applied.filter((a) => !onDisk.has(a) && !absorbed.has(a));

  // A migration may be unapplied on purpose. `services/gateway/src/db.ts` defers a migration
  // declaring `-- requires-extension: X` when this cluster cannot supply X, and deliberately does
  // not record it as applied: a migration attempted where its extension is absent throws, rolls
  // back, un-sets the pool and rethrows, and the gateway starts anyway — the platform serving with
  // no database while reporting itself healthy.
  //
  // This probe is stricter than an exemption, because it is talking to the actual database: it asks
  // the cluster what it offers rather than taking the directive's word, so a migration whose
  // declared extension is available and which still has not run is a real disagreement.
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
  // Reported, never silent: an unapplied migration is a fact an operator should be told, even when
  // it is the correct one. It is the difference between this platform's schema and the schema this
  // checkout describes.
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

// Every run names a version, or the evaluation track is reading noise.
//
// zz.run is derived from zz.event by reconcileRuns() on a timer, keyed on the version. A null
// skill_version_id cannot match that insert's conflict target, because Postgres treats NULLs as
// distinct, so `do update` never fires and each pass of the timer appends another copy — and a table
// full of rows that look like runs reads, in every query, as a healthy table.
//
// Nothing offline can see it: the gate is static and cannot reach a database, and tsc cannot see
// inside a template literal.
//
// Read-only, like everything in this file. A null row is reported, never deleted: a doctor that
// fixed what it found would be one nobody could safely run while something was broken.
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

// R13 · A probe deletes what it creates, and the store is where you find out it did not.
//
// `chain-check` opens a fresh initiative on every run and closes it; closing is not deleting.
// `release.ts` sweeps after itself, and this is what says whether the sweep is working, on the one
// deployment where it matters.
//
// Not a gate check: the gate is offline and this is a fact about data. The source can be perfect
// while the store fills up.
probe("no initiative in the store was left behind by a probe", () => {
  const n = psql("select count(*) from zz.initiative where slug like '%chain-check-%'").trim();
  if (n === "") throw new Error("could not count zz.initiative on the host");
  if (n === "0") return null;
  return `${n} initiative(s) named chain-check-* are still in the store. The live chain check ` +
         `opens one per run and release.ts is supposed to purge them afterwards — a count above ` +
         `zero means that sweep did not run, and every measurement taken over this store is ` +
         `being taken over test traffic. scripts/ops/purge-probes.ts removes them.`;
});

// R5 · A status is a gate verdict, so only a document its flow gates may carry one.
//
// Whether a document is adjudicated is decided per flow and per document by that flow's manifest.
// The manifests are in this checkout and the documents are on the deployment, so this is the one
// place the two can be compared — and neither half can answer it alone.
//
// `handover.md` is the platform's own, appended gated to every flow that gates anything, so it is
// expected to carry one wherever it appears.
//
// DELIBERATE: a closed initiative is not read. It ran under the manifest of its day, and a flow
// that later stops gating a document (0.76.0's findings.md) does not make an approval somebody
// really gave into a false one. Rewriting its frontmatter would erase who agreed and when; and a
// closed initiative's status feeds no gate anyone can still pass. What this protects is a live
// initiative whose document claims an agreement its flow never asks for.
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
    "where status <> '' and path not like '\\_versions/%' " +
    "and not exists (select 1 from zz.doc c where c.team_slug = zz.doc.team_slug " +
    "and c.initiative = zz.doc.initiative and c.outcome <> '')").split("\n").filter(Boolean);
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

probe("no event names an initiative that does not exist in that event's own team", () => {
  // DELIBERATE: not count-bounded, unlike the probe below. The history behind this one was cleaned
  // rather than left to age out, so zero is reachable and anything above it is new.
  //
  // COUPLED: the team is part of the question. `zz.initiative` is unique on `(team_id, slug)`, not
  // on slug, so "the slug exists" is not "the slug exists here" — one slug can live in two teams,
  // and a team-blind version of this query calls both attributions valid while calling neither
  // wrong.
  const bad = psql(
    "select count(*) from zz.event e where e.initiative is not null" +
    " and not exists (select 1 from zz.initiative i join zz.team t on t.id = i.team_id" +
    "                  where i.slug = e.initiative and t.slug is not distinct from e.team_slug)").trim();
  const n = Number(bad);
  if (Number.isNaN(n)) throw new Error("could not count cross-team attributions on the host");
  if (!n) return null;
  return `${n} event row(s) name an initiative that does not exist in the team the row is ` +
         `filed under. A slug means something different, or nothing, in the next team, so ` +
         `these rows attribute work to an initiative that never saw it — and every per-team ` +
         `report reads them. The trace carries the initiative forward on the caller; it must ` +
         `withhold it when the team changes.`;
});

// R11 · Attribution is looked up, and the gate can only see that it is. The gate asserts telemetry
// resolves the plugin from the door and never from the caller's step trace; that is the mechanism
// rather than the property, and a rewrite can satisfy the grep and leave every row null.
//
// A door is a plugin's declared server, so a call that arrived on one is attributable by
// construction; the only honest null is a surface no manifest claims, which is `admin`. So this
// counts what is not attributed and excludes that one.
probe("recent tool calls name the plugin whose door they arrived on", () => {
  // The last 200 calls, not all of them. Attribution is a property of the code that wrote a row, and
  // rows written before pluginForDoor landed carry nulls no deploy can fill; counting them forever
  // is a check that cannot pass, which people learn to scroll past. `plugin_version is not null` is
  // not a usable boundary either — the old path set that column too whenever its guess resolved.
  //
  // A count-bounded window needs no timestamp and no marker, and corrects itself as the platform is
  // used. Expect it red for a short while after a release that changes the write path, while the
  // window still holds rows the old code wrote.
  //
  // `admin` is excluded: no manifest claims it, so it is the one null this platform is entitled to.
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
