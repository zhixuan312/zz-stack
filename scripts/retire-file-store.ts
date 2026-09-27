#!/usr/bin/env node
/**
 * retire-file-store — the team file store archived once, verified, and removed. The phase's one
 * irreversible act (Task I-41, ← AC-8.1, AC-8.3).
 *
 * The store is every team's folder: the documents, the frozen copy filed beside each approved one,
 * the journal shelf, `_ledger.md`, `activity.jsonl` and the `.git` repository `commitStore` kept
 * beside them. Before this runs the same facts live in `zz.doc`, `zz.doc_revision`, `zz.doc_link`
 * and `zz.knowledge_node`; after it runs they live nowhere else, so the archive this writes is the
 * last copy of the store's text and the thing an operator keeps.
 *
 *   node scripts/retire-file-store.ts --store /artifacts --dest /root/zz-backups
 *   node scripts/retire-file-store.ts --store ./fixtures/store --dest /tmp/out --dry-run
 *
 * WHY IT TAKES BOTH PATHS AND DEFAULTS TO NEITHER. `--store` and `--dest` are required and neither
 * has a default, because a script that defaults to the deployment it is run on is a script that
 * retires production the first time somebody types its name to see what it does.
 *
 * WHY THE ARCHIVE IS NAMED `zz-store-archive-<stamp>.tar.gz`. `deploy/backup.sh` prunes
 * `$BACKUP_DIR` by `-mtime "+$KEEP_DAYS"` on a basename glob of everything that script writes, so
 * an archive dropped beside a nightly set under a name like `zz-artifacts-…` would be deleted on
 * day fifteen. The prefix is the exemption, this script REFUSES a destination name outside it, and
 * it refuses too when `deploy/backup.sh` has stopped stating the exemption — an exemption nothing
 * declares is an archive nothing spares.
 *
 * WHY IT REFUSES A SECOND ARCHIVE OF THE SAME STORE. "Archived once" is the claim, and it is the
 * claim that makes the archive evidence: a second archive of the same store means either the first
 * was ignored or the store was rebuilt between the two, and neither is a state an operator should
 * discover later. The store is identified by the root path its manifest names, read back out of
 * each archive already in the destination.
 *
 * WHY IT VERIFIES BEFORE IT REMOVES. The archive is extracted into a scratch directory and every
 * file's sha256 is compared with the manifest taken from the store before the tar; a mismatch
 * means the archive is not a backup of what it replaced, and an archive that is not a backup is
 * not a reason to delete the only other copy. The unverified archive is removed — it would
 * otherwise sit in the destination and refuse the retry as a "second archive" — and the store is
 * left exactly as it was.
 *
 * WHY A FAILED REMOVAL IS REPORTED AND NOT SWALLOWED. Past the verification the archive is real
 * and the store is redundant, so this is the one point where partial success exists: what is left
 * is listed by name and the run exits non-zero, because "the store is gone" and "some of the store
 * is gone" are different facts and the second one is the one an operator has to finish.
 *
 * DELIBERATE: it never touches the platform database, and it imports nothing from `services/`. The
 * act is a filesystem one — archive, verify, remove — and a script that reached into the platform
 * would be a second caller of code this task is retiring.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, lstatSync, readFileSync, readdirSync, rmSync,
         writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** The manifest member, carried INSIDE the archive. A manifest beside the archive would not
 *  travel with it, and the two questions this script asks of an archive already in the
 *  destination — whose store is this, and do its bytes match — are both asked of a copy an
 *  operator may have moved by hand. */
const MANIFEST_MEMBER = ".zz-retire-manifest.json";

/** The prefix `deploy/backup.sh` spares, and the one name this script will write. */
const ARCHIVE_PREFIX = "zz-store-archive-";

/** One entry of the archive, as the store held it. `bytes` and `sha256` are null for a directory
 *  and a symlink, because there are no bytes to hash — never 0, which would read as an empty
 *  file. */
interface Entry {
  path: string;
  kind: "file" | "dir" | "symlink";
  bytes: number | null;
  sha256: string | null;
}

/** What the archive holds, and what it replaced. */
interface Manifest {
  store: string;
  archive: string;
  stamp: string;
  generated_at: string;
  totals: { files: number; dirs: number; symlinks: number; bytes: number };
  entries: Entry[];
}

/* ------------------------------------------------------------------------------ the arguments */

interface Args {
  store: string;
  dest: string;
  dryRun: boolean;
}

/** The usage line, returned rather than thrown: this script's refusals are its output. */
const USAGE = "usage: node scripts/retire-file-store.ts --store <store path> --dest <destination " +
  "directory or " + ARCHIVE_PREFIX + "<stamp>.tar.gz> [--dry-run]";

function parseArgs(argv: string[]): Args | string {
  const flags = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") { dryRun = true; continue; }
    const eq = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (eq) { flags.set(eq[1], eq[2]); continue; }
    const named = /^--([a-z-]+)$/.exec(arg);
    if (named) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return `ERROR: ${arg} needs a value.\n${USAGE}`;
      flags.set(named[1], value);
      i++;
      continue;
    }
    return `ERROR: unexpected argument ${JSON.stringify(arg)}.\n${USAGE}`;
  }
  const store = flags.get("store");
  const dest = flags.get("dest");
  const unknown = [...flags.keys()].filter((k) => k !== "store" && k !== "dest");
  if (unknown.length) return `ERROR: unknown option${unknown.length > 1 ? "s" : ""} --${unknown.join(", --")}.\n${USAGE}`;
  if (!store) return `ERROR: --store is required, and there is no default: a default would be this ` +
    `deployment.\n${USAGE}`;
  if (!dest) return `ERROR: --dest is required, and there is no default: the archive has to land ` +
    `somewhere an operator named.\n${USAGE}`;
  return { store, dest, dryRun };
}

/* --------------------------------------------------------------------------------- the store */

function hashFile(path: string): { bytes: number; sha256: string } {
  const bytes = readFileSync(path);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Every entry under `root`, in a fixed order so two runs over one store make one manifest.
 *
 * DELIBERATE: nothing is skipped. The frozen copies filed beside approvals, the journal shelf,
 * `activity.jsonl`, `_ledger.md` and `.git` are the store's other records, and an archive that
 * left them out would be an archive of the documents only — which is not what "the last copy of
 * the store's text" means. The manifest member this script writes is skipped, so re-running after
 * a failed removal describes the store rather than describing its own leftover.
 *
 * `lstatSync`, never `statSync`: a symbolic link is an entry of the store whether or not what it
 * points at is still there, and `statSync` answers "nothing" for a broken one — so a store with a
 * dangling link would be tarred with an entry the manifest never named, and the verification pass
 * would refuse an archive that is in fact complete. */
function walk(root: string, rel = ""): Entry[] {
  const out: Entry[] = [];
  const here = rel ? join(root, rel) : root;
  for (const name of readdirSync(here).sort()) {
    if (!rel && name === MANIFEST_MEMBER) continue;
    const child = rel ? `${rel}/${name}` : name;
    const stat = lstatSync(join(here, name), { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink()) out.push({ path: child, kind: "symlink", bytes: null, sha256: null });
    else if (stat.isDirectory()) {
      out.push({ path: child, kind: "dir", bytes: null, sha256: null });
      out.push(...walk(root, child));
    } else if (stat.isFile()) {
      const h = hashFile(join(here, name));
      out.push({ path: child, kind: "file", bytes: h.bytes, sha256: h.sha256 });
    }
  }
  return out;
}

function manifestOf(store: string, archive: string, stamp: string, entries: Entry[]): Manifest {
  const files = entries.filter((e) => e.kind === "file");
  return {
    store: resolve(store),
    archive,
    stamp,
    generated_at: new Date().toISOString(),
    totals: {
      files: files.length,
      dirs: entries.filter((e) => e.kind === "dir").length,
      symlinks: entries.filter((e) => e.kind === "symlink").length,
      bytes: files.reduce((n, e) => n + (e.bytes ?? 0), 0),
    },
    entries,
  };
}

/** `tar xzOf` for one member, or null when the archive does not carry it. */
function memberOf(archive: string, member: string): string | null {
  for (const name of [`./${member}`, member]) {
    try {
      return execFileSync("tar", ["xzOf", archive, name],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    } catch { /* try the other spelling */ }
  }
  return null;
}

/** A stored manifest, narrowed. `JSON.parse` hands back `unknown` here and every field is asked
 *  for before it is believed: an archive in the destination may have been written by an older
 *  version of this script, or edited, and a cast would turn either into a wrong answer. */
function asManifest(text: string): Manifest | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.store !== "string") return null;
  const totals = typeof o.totals === "object" && o.totals !== null
    ? o.totals as Record<string, unknown> : {};
  if (typeof totals.files !== "number" || typeof totals.bytes !== "number") return null;
  if (!Array.isArray(o.entries)) return null;
  const entries: Entry[] = [];
  for (const raw of o.entries) {
    if (typeof raw !== "object" || raw === null) return null;
    const e = raw as Record<string, unknown>;
    if (typeof e.path !== "string") return null;
    if (e.kind !== "file" && e.kind !== "dir" && e.kind !== "symlink") return null;
    entries.push({
      path: e.path,
      kind: e.kind,
      bytes: typeof e.bytes === "number" ? e.bytes : null,
      sha256: typeof e.sha256 === "string" ? e.sha256 : null,
    });
  }
  return { store: o.store, archive: typeof o.archive === "string" ? o.archive : "",
           stamp: typeof o.stamp === "string" ? o.stamp : "",
           generated_at: typeof o.generated_at === "string" ? o.generated_at : "",
           totals: { files: totals.files, dirs: 0, symlinks: 0, bytes: totals.bytes }, entries };
}

/* ------------------------------------------------------------------------ the two exemptions */

/** The prune's exemption, read from the script that does the pruning. A destination is refused
 *  when `deploy/backup.sh` no longer states it: the exemption lives in that file, and this script
 *  asserting it in its own would be the second copy of a rule that has one home. */
function pruneExemptionRefusal(): string | null {
  const backup = "deploy/backup.sh";
  if (!existsSync(backup)) {
    return `ERROR: ${backup} is not here, so the nightly prune cannot be read and this script ` +
      `cannot prove the archive outlives it. Run from the repository root.`;
  }
  if (!new RegExp(`${ARCHIVE_PREFIX}\\*`).test(readFileSync(backup, "utf8"))) {
    return `ERROR: ${backup} no longer states the ${ARCHIVE_PREFIX}* exemption, so the nightly ` +
      `prune would delete the archive after $KEEP_DAYS days. Restore the exemption before ` +
      `archiving: this archive is the only remaining copy of the store's text.`;
  }
  return null;
}

/** A destination name the nightly prune would take. The prune walks what `backup.sh` writes, by
 *  basename glob; the prefix above is what it does not walk, so anything else is refused. */
function destinationRefusal(archive: string): string | null {
  if (basename(archive).startsWith(ARCHIVE_PREFIX)) return null;
  return `ERROR: ${basename(archive)} is a name the nightly prune in deploy/backup.sh would ` +
    `delete — it prunes $BACKUP_DIR by -mtime "+$KEEP_DAYS" on a basename glob, and the one name ` +
    `it spares is ${ARCHIVE_PREFIX}*. Name the archive ${ARCHIVE_PREFIX}<stamp>.tar.gz, or pass a ` +
    `destination directory and let this script name it.`;
}

/** The archives already in the destination, and the store each one names. */
function archivedStores(destDir: string): { archive: string; store: string | null }[] {
  if (!existsSync(destDir)) return [];
  return readdirSync(destDir).filter((n) => n.startsWith(ARCHIVE_PREFIX) && n.endsWith(".tar.gz"))
    .sort()
    .map((name) => {
      const archive = join(destDir, name);
      const text = memberOf(archive, MANIFEST_MEMBER);
      return { archive, store: text ? (asManifest(text)?.store ?? null) : null };
    });
}

/* ------------------------------------------------------------------------------ verification */

/** The archive read back and compared with the manifest it carries.
 *
 * The extraction is the whole proof: a listing proves the entry names travelled and nothing about
 * their bytes, and a store whose archive held truncated documents would pass a listing on the day
 * the store is deleted. Every regular file is hashed from the extracted copy, and the two sets of
 * paths have to be equal in both directions, so a member the manifest does not name fails the same
 * way a file the archive lost does. */
function verify(archive: string, expected: Manifest): { ok: true } | { ok: false; why: string } {
  const work = mkdtempSync(join(tmpdir(), "zz-retire-verify-"));
  try {
    execFileSync("tar", ["xzf", archive, "-C", work],
      { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    const found = walk(work).filter((e) => e.path !== MANIFEST_MEMBER);
    const byPath = new Map(found.map((e) => [e.path, e]));
    const want = new Map(expected.entries.map((e) => [e.path, e]));
    for (const [path, e] of want) {
      const got = byPath.get(path);
      if (!got) return { ok: false, why: `${path} is named by the manifest and is not in the archive` };
      if (got.kind !== e.kind) {
        return { ok: false, why: `${path} is a ${e.kind} in the manifest and a ${got.kind} in the archive` };
      }
      if (e.kind === "file" && got.sha256 !== e.sha256) {
        return { ok: false, why: `${path} hashes ${got.sha256} in the archive and ${e.sha256} in the ` +
          `manifest — the archive is not the bytes it replaced` };
      }
    }
    for (const path of byPath.keys()) {
      if (!want.has(path)) return { ok: false, why: `${path} is in the archive and in no manifest entry` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, why: `the archive does not extract: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------------------------- the act */

function main(): number {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === "string") { console.error(parsed); return 2; }
  const { store, dest, dryRun } = parsed;

  const storeRoot = resolve(store);
  if (!existsSync(storeRoot) || !lstatSync(storeRoot).isDirectory()) {
    console.error(`ERROR: ${store} is not a directory — there is no store there to retire.`);
    return 1;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const destIsArchive = dest.endsWith(".tar.gz");
  const archive = destIsArchive ? resolve(dest) : join(resolve(dest), `${ARCHIVE_PREFIX}${stamp}.tar.gz`);
  const destDir = dirname(archive);

  const exempt = pruneExemptionRefusal();
  if (exempt) { console.error(exempt); return 1; }
  const named = destinationRefusal(archive);
  if (named) { console.error(named); return 1; }

  const already = archivedStores(destDir).filter((a) => a.store === storeRoot);
  if (already.length) {
    console.error(`ERROR: ${storeRoot} is already archived in ${destDir} as ` +
      `${basename(already[0].archive)}, and "archived once" is the claim this script makes. A ` +
      `second archive of one store means the first was ignored or the store was rebuilt between ` +
      `the two — inspect it and remove it by hand if it is genuinely superseded.`);
    return 1;
  }
  if (existsSync(archive)) {
    console.error(`ERROR: ${archive} already exists. Nothing here overwrites an archive: a ` +
      `second one under the same stamp would either clobber the first or read as a pair of ` +
      `retirements that never happened.`);
    return 1;
  }

  const entries = walk(storeRoot);
  if (!entries.length) {
    console.error(`ERROR: ${storeRoot} holds nothing — an empty archive is not a backup, and ` +
      `removing the store would delete the evidence that it was empty.`);
    return 1;
  }
  const manifest = manifestOf(storeRoot, archive, stamp, entries);
  console.log(`[retire] ${storeRoot}: ${manifest.totals.files} file(s), ${manifest.totals.dirs} ` +
    `director(ies), ${manifest.totals.bytes} byte(s) -> ${archive}`);

  if (dryRun) {
    console.log(`[retire] --dry-run: nothing written and nothing removed. Without --dry-run this ` +
      `would archive the store whole, extract the archive back, compare every file's sha256 with ` +
      `the manifest, and only then remove ${storeRoot}.`);
    return 0;
  }

  mkdirSync(destDir, { recursive: true });
  // The manifest is written INTO the store root first so it travels inside the archive: both
  // questions asked of an archive in the destination are asked of the archive alone.
  writeFileSync(join(storeRoot, MANIFEST_MEMBER), JSON.stringify(manifest, null, 2) + "\n");

  try {
    execFileSync("tar", ["czf", archive, "-C", storeRoot, "."],
      { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    console.error(`ERROR: the archive could not be written: ` +
      `${err instanceof Error ? err.message : String(err)}. The store is untouched.`);
    return 1;
  }

  const check = verify(archive, manifest);
  if (!check.ok) {
    rmSync(archive, { force: true });
    console.error(`ERROR: the archive does not match what it replaced (${check.why}). An archive ` +
      `that does not match is not a backup, so ${storeRoot} is untouched and the unverified ` +
      `archive has been removed.`);
    rmSync(join(storeRoot, MANIFEST_MEMBER), { force: true });
    return 1;
  }
  console.log(`[retire] verified: every one of ${manifest.totals.files} file(s) reads back from ` +
    `${basename(archive)} with the hash it was written with`);

  // Past this line the archive is real and the store is redundant. The manifest comes out first
  // so that a removal which fails leaves the store exactly as this script found it.
  rmSync(join(storeRoot, MANIFEST_MEMBER), { force: true });
  rmSync(storeRoot, { recursive: true, force: true });

  const left = existsSync(storeRoot) ? readdirSync(storeRoot).sort() : [];
  if (left.length) {
    console.error(`ERROR: ${storeRoot} was not removed. Archive: ${archive} (verified, keep it). ` +
      `Still there, by name: ${left.join(", ")}. Remove the remainder by hand, or move it aside — ` +
      `the store must not be left half-retired, because every reader now answers from the database ` +
      `and this is the last copy of the text.`);
    return 1;
  }

  console.log(`[retire] removed ${storeRoot} — the platform reads the database only from here.`);
  console.log(`NOTE: ${archive} is the only remaining copy of the store's text and it is on the ` +
    `same host as the data it protects — copy it off-host to survive disk loss.`);
  console.log(`NOTE: it is named ${ARCHIVE_PREFIX}* on purpose: deploy/backup.sh prunes ` +
    `everything else in this directory by -mtime, and this prefix is the one exemption.`);
  return 0;
}

process.exit(main());
