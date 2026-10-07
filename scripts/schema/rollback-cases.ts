/**
 * The cases `checks/rollback-boundary.ts` runs (AC-5.1): the rollback guard asked of a fixture
 * repository and of this checkout, the lines a refused rollback prints, the release script and the
 * deploy texts read as text, and the previous release's own statements run against new-format
 * state filled through a real zz-core.
 *
 * The previous release is derived from git — the first `v*` tag, newest first, whose tree has no
 * `002_document_versions.sql` — and its revision insert and public-version rendering are read from
 * that tag's `services/zz-core/src/versions.ts` with `git show` at run time, never retyped. They
 * are the old STATEMENTS, run here, not the old image: what the old image would do on this schema,
 * statement by statement.
 *
 * COUPLED: the fold. When `002_document_versions.sql` folds into `001_init.sql` after the release
 * verifies, the fold removes its refusal line and repoints `MIGRATION` and `previousRelease`, as
 * every fold repoints the checks that read the `002` file.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs, so the cases that
 * check runs live here, beside the harness they run on.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { root } from "../deployment.ts";
import { type Guarded, refusalLines, rollbackGuard } from "../release/rollback-guard.ts";
import type { Core } from "./throwaway-core.ts";
import { type Gateway, start } from "./upload-cases.ts";

/** The migration this release ships that the previous release's code cannot write. */
const MIGRATION = "002_document_versions.sql";
const MIGRATIONS = "services/gateway/migrations";
const GUARDED = "node scripts/release.ts --rollback";
const DECLARATION = "-- rollback: refused";

/** One case that did not hold: its name and what was found. */
export class CaseFailed extends Error {}
const fail = (step: string, detail: string): never => { throw new CaseFailed(`FAILED at "${step}": ${detail}`); };
const pass = (step: string): void => console.log(`  ${step}: ok`);
const git = (args: string[], cwd = root): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const json = (v: unknown): string => JSON.stringify(v);

/** The release a rollback from HEAD goes back to: the newest `v*` tag without this release's
 *  migration, as a bare version. */
export function previousRelease(): string {
  for (const tag of git(["tag", "--list", "v*", "--sort=-v:refname"]).split("\n").filter(Boolean)) {
    try {
      git(["cat-file", "-e", `${tag}:${MIGRATIONS}/${MIGRATION}`]);
    } catch {
      return tag.slice(1);
    }
  }
  return fail("derive the previous release", `no v* tag lacks ${MIGRATION} — there is no release to roll back to`);
}

/** The guard over a fixture repository: a declaration, destructive DDL, neither, and no tag. */
export function guardCases(): void {
  const repo = mkdtempSync(join(tmpdir(), "rollback-guard-"));
  try {
    const dir = join(repo, MIGRATIONS);
    mkdirSync(dir, { recursive: true });
    const g = (...a: string[]) => git(["-c", "user.email=check@example.test", "-c", "user.name=check",
                                       "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...a], repo);
    g("init", "-q");
    writeFileSync(join(dir, "001_init.sql"), "CREATE TABLE zz.t (a integer);\n");
    g("add", ".");
    g("commit", "-q", "-m", "one");
    g("tag", "v1.0.0");

    let step = "a migration with neither a declaration nor destructive DDL permits the rollback";
    writeFileSync(join(dir, "004_plain.sql"), "-- adds a nullable column\nALTER TABLE zz.t ADD COLUMN b integer;\n");
    let got = rollbackGuard("1.0.0", repo);
    if (json(got) !== json({ refusals: [] }) || refusalLines("1.1.0", "1.0.0", got).length) fail(step, json(got));
    pass(step);

    step = "a migration declaring `-- rollback: refused — <reason>` refuses, naming the file and its reason";
    writeFileSync(join(dir, "002_declared.sql"),
                  "-- 002_declared.sql — a header\n--\n-- rollback: refused — the old writer cannot fill b\n" +
                  "ALTER TABLE zz.t ALTER COLUMN a SET NOT NULL;\n");
    got = rollbackGuard("1.0.0", repo);
    if (json(got) !== json({ refusals: [{ file: "002_declared.sql", reason: "the old writer cannot fill b" }] })) fail(step, json(got));
    pass(step);

    step = "destructive DDL still refuses, with its existing reason";
    writeFileSync(join(dir, "003_destructive.sql"), "ALTER TABLE zz.t DROP COLUMN a;\n");
    got = rollbackGuard("1.0.0", repo);
    const refusals = "refusals" in got ? got.refusals : [];
    if (refusals.map((r) => r.file).join(",") !== "002_declared.sql,003_destructive.sql"
        || !/drops something 1\.0\.0's code still reads/.test(refusals[1]?.reason ?? "")
        || !/answer 500 to every caller while \/health stayed green/.test(refusals[1]?.reason ?? "")) fail(step, json(got));
    pass(step);

    step = "a version with no tag is the guard's error, never every migration counted as new";
    got = rollbackGuard("9.9.9", repo);
    if (json(got) !== json({ error: "no tag v9.9.9" })) fail(step, json(got));
    pass(step);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

/** The guard over this checkout, back to the derived previous release. */
export function headCases(previous: string): void {
  const step = `from HEAD back to v${previous} (the newest tag without ${MIGRATION}) the refusing set is exactly {${MIGRATION}}, with its declared reason`;
  const declared = readFileSync(join(root, MIGRATIONS, MIGRATION), "utf8").split("\n")
    .find((l) => l.startsWith(`${DECLARATION} — `))?.slice(`${DECLARATION} — `.length).trim();
  if (!declared) fail(step, `${MIGRATION} carries no \`${DECLARATION} — <reason>\` line`);
  const got = rollbackGuard(previous);
  if (json(got) !== json({ refusals: [{ file: MIGRATION, reason: declared }] })) fail(step, json(got));
  pass(step);
}

/** The lines `--rollback` and step 6 print on a refusal and on a guard error. */
export function lineCases(): void {
  let step = "a refusal prints every verification failure, every reason, and that the release is STILL LIVE; fix forward";
  const refused: Guarded = { refusals: [{ file: "002_a.sql", reason: "reason a" }, { file: "003_b.sql", reason: "reason b" }] };
  let text = refusalLines("0.94.0", "0.93.3", refused, ["probe one failed", "probe two failed"]).join("\n");
  for (const want of ["probe one failed", "probe two failed", "002_a.sql: reason a", "003_b.sql: reason b", "0.94.0 is STILL LIVE; fix forward"]) {
    if (!text.includes(want)) fail(step, `no "${want}" in:\n${text}`);
  }
  pass(step);

  step = "a guard error prints the missing tag and that the guard cannot know what that version's code expects";
  text = refusalLines("0.94.0", "0.93.3", { error: "no tag v0.93.3" }).join("\n");
  for (const want of ["no tag v0.93.3", "cannot know what that version's code expects", "0.94.0 is STILL LIVE; fix forward"]) {
    if (!text.includes(want)) fail(step, `no "${want}" in:\n${text}`);
  }
  pass(step);
}

/** The release script, the rollback and the three deploy texts, read as text. */
export function textCases(): void {
  let step = "release step 6 asks the guard before its try, and its refusal branch dies before the rollback is called";
  const rel = readFileSync(join(root, "scripts/release.ts"), "utf8");
  const open = "if (problems.length) {";
  if (rel.indexOf(open) < 0 || rel.indexOf(open) !== rel.lastIndexOf(open)) fail(step, `"${open}" is not unique in scripts/release.ts`);
  const end = rel.indexOf('step(7, "tag")', rel.indexOf(open));
  if (end < 0) fail(step, "step 7 does not follow step 6");
  const block = rel.slice(rel.indexOf(open), end);
  const asked = block.indexOf("rollbackGuard(");
  const guarded = block.indexOf("try {");
  const called = block.search(/\brollback\(previous\)/);
  if (asked < 0 || guarded < 0 || called < 0 || !(asked < guarded && guarded < called)) {
    fail(step, `rollbackGuard( at ${asked}, try { at ${guarded}, rollback(previous) at ${called} — the guard must come first`);
  }
  // From the start of the statement that asks it: its condition sits on the same line.
  const branch = block.slice(block.lastIndexOf("\n", asked), guarded);
  if (!/previous\s*!==\s*version/.test(branch)) fail(step, "the guard is not asked only when the previous version differs from this release's");
  if (!/\bdie\(/.test(branch) || !/refusalLines\(/.test(branch) || /\brollback\(/.test(branch)) {
    fail(step, `the refusal branch must die with refusalLines and never call rollback():\n${branch}`);
  }
  pass(step);

  step = "--rollback asks the guard before the first ssh that changes the host, and dies with its lines";
  const rb = readFileSync(join(root, "scripts/release/rollback.ts"), "utf8");
  const g = rb.indexOf("rollbackGuard(");
  const moves = rb.indexOf('step("↩"');
  if (g < 0 || moves < 0 || g > moves || !/die\([^;]*refusal/.test(rb.slice(g, moves))) {
    fail(step, `rollbackGuard( at ${g}, the first host change at ${moves}`);
  }
  if (/IRREVERSIBLE|migrationsSince/.test(rb)) fail(step, "rollback.ts still carries a guard of its own beside rollback-guard.ts");
  pass(step);

  step = `the compose header, the .env.example ZZ_VERSION comment and release.ts's header name \`${GUARDED}\` and \`${DECLARATION}\``;
  const compose = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8");
  const header = compose.slice(0, compose.indexOf("\nservices:"));
  const env = readFileSync(join(root, "deploy/.env.example"), "utf8");
  const at = env.indexOf("\n# ZZ_VERSION=\n");
  const paragraph = at < 0 ? "" : env.slice(env.lastIndexOf("\n\n", at) + 2, at);
  const docstring = rel.slice(rel.indexOf("/**"), rel.indexOf("*/") + 2);
  for (const [where, text] of [["deploy/docker-compose.yml's header", header], ["deploy/.env.example's ZZ_VERSION comment", paragraph],
                               ["scripts/release.ts's header", docstring]] as const) {
    if (!text) fail(step, `${where} cannot be located`);
    const flat = text.replace(/\n\s*(#|\*)\s*/g, " ");
    if (!flat.includes(GUARDED) || !flat.includes(DECLARATION)) fail(step, `${where} does not name \`${GUARDED}\` and \`${DECLARATION}\``);
  }
  pass(step);
}

/** Every table of the `zz` schema as a row count and a digest of its rows. */
async function tables(c: Core): Promise<Map<string, string>> {
  const names = (await c.sql.query<{ t: string }>(
    `select table_name as t from information_schema.tables
      where table_schema = 'zz' and table_type = 'BASE TABLE' order by 1`)).rows.map((r) => r.t);
  const out = new Map<string, string>();
  for (const t of names) {
    const { rows } = await c.sql.query<{ s: string }>(
      `select count(*) || ':' || coalesce(md5(string_agg(x::text, E'\\n' order by x::text)), '') as s from zz."${t}" x`);
    out.set(t, rows[0].s);
  }
  return out;
}

/** The tables once nothing has written for three reads in a row — `platformEvent` lands its rows
 *  after a tool's reply. */
async function settled(c: Core, step: string): Promise<Map<string, string>> {
  let last = await tables(c);
  for (let same = 0, i = 0; same < 3; i++) {
    if (i > 100) fail(step, "the database never settled");
    await new Promise((r) => setTimeout(r, 200));
    const now = await tables(c);
    same = json([...now]) === json([...last]) ? same + 1 : 0;
    last = now;
  }
  return last;
}

interface DocRow { id: string; version: number; revision: number; generation: number }

async function rowOf(c: Core, initiative: string, path: string): Promise<DocRow> {
  const { rows } = await c.sql.query<DocRow>(
    `select d.id::text as id, d.current_version as version, d.current_revision as revision,
            d.content_generation::int as generation
       from zz.doc d join zz.initiative i on i.id = d.initiative_id where i.slug = $1 and d.path = $2`, [initiative, path]);
  return rows[0] ?? fail(`row of ${initiative}/${path}`, "no such document");
}

/**
 * The previous release's statements on new-format state, the runner re-run as a no-op, and the
 * new image writing on (fix forward).
 */
export async function boundary(c: Core, g: Gateway, previous: string): Promise<void> {
  const I = await c.open("rollback-boundary");
  const n = `${I}/notes.md`;
  const tag = `v${previous}`;

  let step = "new-format state through the real zz-core: several public versions and content generations, a keyed receipt, a presentation's coverage, a same-version correction and a consumed upload";
  await c.ok(step, "document_write", { path: n, content: "# Notes\n\none\n" });
  const caused = await c.ok(step, "document_edit", { path: n, edits: [{ find: "one", replace: "two" }],
                                                     source_content: "the call moved it to two", request_id: "rb-keyed-1" });
  if (caused.split("\n")[0] !== `edited: ${n} — v2 (new version)`) c.fail(step, caused);
  await c.ok(step, "document_present", { path: n });
  const corrected = await c.ok(step, "document_edit", { path: n, edits: [{ find: "two", replace: "two, corrected" }] });
  if (corrected.split("\n")[0] !== `edited: ${n} — v2`) c.fail(step, corrected);
  const s = await start(c, step, "scores.csv");
  const ran = await g.run(s.shell, "scores.csv", Buffer.from("name,score\nada,3\n"));
  if (ran.code !== 0) c.fail(step, `the shell exited ${ran.code}: ${ran.out.slice(0, 300)}`);
  await c.ok(step, "document_write", { path: `${I}/scores.md`, upload: s.upload });
  const doc = await rowOf(c, I, "notes.md");
  const { rows: [held] } = await c.sql.query<{ keyed: number; consumed: number; covered: number }>(
    `select (select count(*)::int from zz.doc_request where request_id = 'rb-keyed-1') as keyed,
            (select count(*)::int from zz.upload where id = $1 and consumed_at is not null) as consumed,
            (select count(*)::int from zz.event where detail->>'review_context' is not null) as covered`,
    [s.upload]);
  if (doc.version !== 2 || doc.revision !== 3 || doc.generation < 2 || held.keyed !== 1 || held.consumed !== 1 || held.covered < 1) {
    c.fail(step, json({ doc, held }));
  }
  c.pass(step);

  console.log(`  (the next two cases run ${tag}'s own statements, read from its tag — not ${tag}'s image)`);
  const old = git(["show", `${tag}:services/zz-core/src/versions.ts`]);

  step = `${tag}'s revision insert, read from its tag, is refused on this schema by the NOT NULL version column`;
  const insert = /async function insertRevision[\s\S]*?`(\s*insert into zz\.doc_revision[\s\S]*?)`/.exec(old)?.[1]
    ?? c.fail(step, `no \`insert into zz.doc_revision\` in insertRevision at ${tag}:services/zz-core/src/versions.ts`);
  const writer = (await c.sql.query<{ id: string }>("select id::text as id from zz.principal where email = $1", [c.email])).rows[0].id;
  const params = [doc.id, doc.revision + 1, "Notes", "# Notes\n\nfrom the old image\n", [], "sha256:old", null, writer, null, null, null];
  const wants = Math.max(...[...insert.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  if (wants !== params.length) c.fail(step, `${tag}'s insert takes ${wants} parameters and the check supplies ${params.length}: ${insert}`);
  // Inside a transaction rolled back either way, so an insert that lands leaves nothing behind.
  await c.sql.query("begin");
  type PgError = { code?: string; column?: string; message?: string };
  const refusal = await c.sql.query(insert, params).then(() => null, (err: unknown) => err as PgError)
    .finally(() => c.sql.query("rollback"));
  if (refusal?.code !== "23502" || refusal.column !== "version") {
    c.fail(step, refusal ? `refused, but not by the NOT NULL version column: ${refusal.code} ${refusal.message}`
      : `${tag}'s insert was NOT refused — the previous image could write this schema, and the guard's refusal would rest on nothing`);
  }
  c.pass(step);

  step = `${tag}'s public-version rendering, read from its tag, labels the corrected document with a version it does not have`;
  const render = /^\s*(env\.version = [^;\n]+;)/m.exec(old)?.[1]
    ?? c.fail(step, `no \`env.version = …;\` at ${tag}:services/zz-core/src/versions.ts`);
  const rev = (await c.sql.query("select * from zz.doc_revision where doc_id = $1::uuid and revision = $2", [doc.id, doc.revision])).rows[0];
  const shown = (new Function("rev", `const env = {}; ${render} return env.version;`) as (r: unknown) => unknown)(rev);
  const reads = /^version: (\d+)$/m.exec(await c.ok(step, "document_read", { path: n }))?.[1];
  if (String(shown) === String(doc.version) || reads !== String(doc.version)) {
    c.fail(step, `${tag} renders ${String(shown)}, current_version is ${doc.version}, document_read says ${reads}`);
  }
  c.pass(step);

  step = "the migration runner re-run over the filled database is a no-op that leaves every row as it was";
  const before = await settled(c, step);
  const runner = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${json(pathToFileURL(join(root, "services/gateway/dist/db.js")).href)});
     await m.initPlatformDb();
     if (!m.platformDbReady()) { console.error("the runner left no pool — a migration failed"); process.exit(1); }
     await m.platformDb().end();`],
  { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "", TEAM_DB_URL: c.url } });
  if (runner.status !== 0 || /migration applied/.test(runner.stdout)) {
    c.fail(step, `the runner exited ${runner.status}: ${(runner.stdout + runner.stderr).trim().slice(-600)}`);
  }
  const after = await settled(c, step);
  const moved = [...new Set([...before.keys(), ...after.keys()])].filter((t) => before.get(t) !== after.get(t));
  if (moved.length) c.fail(step, `rows changed in ${moved.join(", ")}`);
  c.pass(step);

  step = "fix forward: one more document_edit and document_read through the same zz-core advance the version from the corrected state";
  const next = await c.ok(step, "document_edit", { path: n, edits: [{ find: "two, corrected", replace: "three" }],
                                                   source_content: "fixed forward to three" });
  const now = await rowOf(c, I, "notes.md");
  const read = await c.ok(step, "document_read", { path: n });
  if (next.split("\n")[0] !== `edited: ${n} — v3 (new version)` || now.version !== 3 || !/^version: 3$/m.test(read) || !/three/.test(read)) {
    c.fail(step, `${next.split("\n")[0]} — ${json(now)}`);
  }
  c.pass(step);
}
