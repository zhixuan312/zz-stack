/**
 * migrate.ts — the `migrate` verb: read-only snapshot in, separate explicitly-identified
 * volume out, three protected reports beside them.
 *
 * DRY RUN IS THE DEFAULT AND IT IS NOT A SIMULATION. Bare, this verb reads the source
 * snapshot, classifies every file with the real importer's own `prepareLegacyManifest`, and
 * writes the manifest an apply would later be given. Nothing at `--target` is touched, and
 * `--target` need not even be named. `--apply` is the only path that writes anything anywhere
 * but the workspace, and `cli.ts` refuses it without both `--target` and `--manifest`.
 *
 * TWO REFUSALS STAND BETWEEN THIS VERB AND A LIVE STORE, and both are checked before a single
 * byte is read:
 *   - LIVE_SOURCE_REFUSED — the source must be a snapshot, not a store something is writing.
 *     A directory carrying `.zz/commits/` or a `.zz/lock` IS a live owner store; so is one that
 *     contains the target, or is contained by it. Read-only-ness cannot be established from a
 *     mode bit on every platform this runs on, so the check is structural, and the flag is
 *     named `--source` rather than `--store` so nobody reaches for it by habit.
 *   - AMBIGUOUS_TARGET — "a separate explicitly identified target volume" means exactly that.
 *     An empty directory qualifies and is claimed by writing `.zz-migration-target.json` into
 *     it; a directory already carrying that marker for this owner and this path qualifies; a
 *     directory with anything else in it does not, and is refused rather than migrated into.
 *
 * THE THREE REPORTS ARE PROTECTED, which here means two things and no more: they are written
 * through `safeWritePath`, which cannot escape the workspace into this checkout or into a live
 * store, and they are left mode 0o444 so nothing rewrites them by accident. A re-run clears
 * that bit deliberately before replacing them, which is the point — replacing migration
 * evidence should be something a program had to decide to do.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import {
  legacyImportPolicy, legacyImportRequest, prepareLegacyManifest, LEGACY_ARCHIVE_DIR,
  LEGACY_MANIFEST_FORMAT_VERSION,
  type LegacyBlockingError, type LegacyConversionManifest, type LegacyManifestPreparation,
  type LegacyManifestRow, type LegacyProfile,
} from "../../services/zz-core/dist/tenant-info/legacy-import.js";
import { mutate } from "../../services/zz-core/dist/tenant-info/mutations.js";

import { CliError } from "./errors.ts";
import { safeWritePath } from "./workspace.ts";

const TARGET_MARKER = ".zz-migration-target.json";

export interface MigrateArgs {
  readonly apply: boolean;
  readonly source?: string;
  readonly target?: string;
  readonly manifest?: string;
  readonly owner?: string;
}

// ── the two refusals ────────────────────────────────────────────────────────────────────────

function resolveExistingDirectory(flag: string, raw: string | undefined): string {
  if (raw === undefined) throw new CliError("INVALID_ARGUMENTS", `--${flag} is required.`);
  if (!existsSync(raw) || !statSync(raw).isDirectory()) {
    throw new CliError("INVALID_ARGUMENTS", `--${flag} "${raw}" does not exist or is not a directory.`);
  }
  return realpathSync(raw);
}

function contains(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(outer + sep);
}

/** A source this verb will read, or a refusal naming why it will not. */
function resolveSource(raw: string | undefined, targetReal: string | null): string {
  const source = resolveExistingDirectory("source", raw);
  if (existsSync(join(source, ".zz", "commits")) || existsSync(join(source, ".zz", "lock"))) {
    throw new CliError(
      "LIVE_SOURCE_REFUSED",
      `"${source}" carries a .zz/ record store — that is a live owner store, not the read-only snapshot this verb reads.`,
    );
  }
  if (targetReal !== null && (contains(source, targetReal) || contains(targetReal, source))) {
    throw new CliError(
      "LIVE_SOURCE_REFUSED",
      `"${source}" and the target "${targetReal}" overlap; a migration reads one volume and writes another.`,
    );
  }
  return source;
}

interface TargetMarker {
  readonly format_version: number;
  readonly target_id: string;
  readonly owner_id: string;
  readonly claimed_at: string;
}

/**
 * The target volume, claimed. An empty directory is claimed here and now; a directory this
 * migration already claimed for this owner is accepted; anything else is ambiguous and is
 * refused rather than guessed at.
 */
function claimTarget(raw: string | undefined, ownerId: string): string {
  const target = resolveExistingDirectory("target", raw);
  const markerPath = join(target, TARGET_MARKER);
  const entries = readdirSync(target);
  if (existsSync(markerPath)) {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<TargetMarker>;
    if (marker.target_id !== target) {
      throw new CliError("AMBIGUOUS_TARGET", `"${target}" carries a ${TARGET_MARKER} claiming ${JSON.stringify(marker.target_id)} — the volume moved, or the marker is another volume's.`);
    }
    if (marker.owner_id !== ownerId) {
      throw new CliError("AMBIGUOUS_TARGET", `"${target}" is already claimed for owner ${JSON.stringify(marker.owner_id)}, not ${ownerId}.`);
    }
  } else if (entries.length > 0) {
    throw new CliError(
      "AMBIGUOUS_TARGET",
      `"${target}" already holds ${entries.length} entr${entries.length === 1 ? "y" : "ies"} and carries no ${TARGET_MARKER}. ` +
      "A migration target is an empty volume this verb claims, or one it claimed before — never a directory it has to guess about.",
    );
  } else {
    const marker: TargetMarker = {
      format_version: LEGACY_MANIFEST_FORMAT_VERSION, target_id: target, owner_id: ownerId,
      claimed_at: new Date().toISOString(),
    };
    writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  }
  mkdirSync(join(target, ".zz", "blobs"), { recursive: true });
  mkdirSync(join(target, ".zz", "commits"), { recursive: true });
  return target;
}

// ── reading the snapshot ────────────────────────────────────────────────────────────────────

/** Every file under the snapshot, as locators relative to its root. `.zz-migration-target.json`
 *  and any `.git` directory are this platform's own bookkeeping rather than a team's content,
 *  and are not carried forward; everything else is, including files this reader cannot parse. */
function walkSnapshot(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name === ".git" || entry.name === TARGET_MARKER) continue;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkSnapshot(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function readSnapshot(source: string): { path: string; bytes: Buffer }[] {
  return walkSnapshot(source).map((path) => ({ path, bytes: readFileSync(join(source, ...path.split("/"))) }));
}

// ── the classification inventory ────────────────────────────────────────────────────────────

export interface ClassificationInventory {
  readonly manifest_id: string;
  /** THE CORPUS THIS INVENTORY IS ABOUT, without which the numbers below answer nothing.
   *
   *  `selected_count: 0` with `review_required: false` is exactly the shape the contract names
   *  as a valid H2 resolution — "a recorded zero-selected/no-review inventory permits lossless
   *  legacy carry-forward without fictitious approval." It is also exactly what this verb
   *  produces over a three-row fixture snapshot in a temp directory, and the two were
   *  BYTE-INDISTINGUISHABLE IN KIND: every other field is a count or a relative path, and a
   *  relative path from a fixture reads like a relative path from a real corpus. Nothing in
   *  the file said which one it described.
   *
   *  A reviewer asked to resolve a human gate needs both halves and had neither in usable
   *  form. `manifest_id` was already a corpus HASH — `manifestIdOf` digests every row's path,
   *  content hash and profile, so two corpora cannot share one — but a hash is an identity,
   *  not a description: it cannot say that this was the production artifact volume rather than
   *  somebody's scratch directory.
   *
   *  Found by the I-25 finalizer, which now refuses to resolve H2 from an inventory carrying
   *  no binding to the material it describes — correctly, and it will keep blocking until a
   *  real conversion is run, because this field makes the receipt CAPABLE of answering the
   *  question without answering it. */
  readonly source_root: string;
  readonly profiles: Readonly<Record<string, number>>;
  /** How many rows a reviewer SELECTED for native semantic conversion. A mechanical
   *  carry-forward selects none, and that is a complete answer. */
  readonly selected_count: number;
  /** False when nothing was selected. The contract is explicit that this is not missing
   *  evidence and does not block the mechanical rows — a migration that carried every file
   *  across as legacy needs no reviewer, because it reinterpreted nothing. */
  readonly review_required: boolean;
  readonly rows: readonly { readonly path: string; readonly profile: LegacyProfile; readonly selected_for_conversion: false }[];
}

/**
 * What this migration decided about meaning, which is: nothing. Semantic conversion of a
 * team's own concepts requires H2 from that team's recorded reviewer, and this verb has no
 * reviewer decision to act on — so every row is carried forward as legacy and
 * `selected_count` is 0.
 */
export function classifyMigration(manifest: LegacyConversionManifest, sourceRoot: string): ClassificationInventory {
  const profiles: Record<string, number> = {};
  for (const row of manifest.rows) profiles[row.profile] = (profiles[row.profile] ?? 0) + 1;
  return {
    manifest_id: manifest.manifest_id,
    source_root: sourceRoot,
    profiles,
    selected_count: 0,
    review_required: false,
    rows: manifest.rows.map((row) => ({ path: row.path, profile: row.profile, selected_for_conversion: false })),
  };
}

// ── parity ──────────────────────────────────────────────────────────────────────────────────

interface ParityRow {
  readonly path: string;
  readonly sha256: string;
  readonly byte_length: number;
  readonly archived: boolean;
  readonly blob_present: boolean;
  readonly bytes_match: boolean;
}

/** Every row's original bytes, checked back out of the target two ways: the content-addressed
 *  blob and the readable archive copy. A parity report that only counted rows would pass a
 *  migration that wrote the right number of wrong files. */
function parityOf(target: string, rows: readonly LegacyManifestRow[]): ParityRow[] {
  return rows.map((row) => {
    const blobPath = join(target, ".zz", "blobs", row.sha256);
    const archivePath = join(target, LEGACY_ARCHIVE_DIR, ...row.path.split("/"));
    const blobPresent = existsSync(blobPath);
    const archived = existsSync(archivePath);
    const bytesMatch = blobPresent && archived
      && readFileSync(blobPath).equals(readFileSync(archivePath))
      && readFileSync(blobPath).byteLength === row.byte_length;
    return { path: row.path, sha256: row.sha256, byte_length: row.byte_length, archived, blob_present: blobPresent, bytes_match: bytesMatch };
  });
}

// ── the receipt ─────────────────────────────────────────────────────────────────────────────

export interface MigrateReceipt {
  readonly verb: "migrate";
  readonly mode: "dry-run" | "apply";
  readonly source: string;
  readonly target: string | null;
  readonly manifest_id: string;
  readonly manifest_path: string;
  readonly input_count: number;
  readonly row_count: number;
  readonly blocking: readonly LegacyBlockingError[];
  readonly imported: readonly { readonly path: string; readonly artifact_id: string; readonly revision: number | null }[];
  readonly refused: readonly { readonly path: string; readonly code: string; readonly message: string }[];
  readonly parity_complete: boolean;
  readonly ok: boolean;
  readonly reports: readonly string[];
  readonly plannedAt: string;
}

/** Written through the workspace guard, then left read-only. A later run that means to replace
 *  one clears the bit first; nothing else can overwrite migration evidence by accident. */
function writeProtected(workspaceReal: string, name: string, body: unknown): string {
  const path = safeWritePath(workspaceReal, name);
  if (existsSync(path)) chmodSync(path, 0o644);
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  chmodSync(path, 0o444);
  return path;
}

/**
 * The whole verb. A dry run stops after the manifest and the classification inventory; an
 * apply imports every row through the real kernel and then re-reads the target to build parity.
 */
export async function runMigrate(workspaceReal: string, args: MigrateArgs): Promise<MigrateReceipt> {
  const ownerId = args.apply ? requireOwner(args.owner) : (args.owner ?? "");
  const target = args.apply ? claimTarget(args.target, ownerId) : null;
  const source = resolveSource(args.source, target);

  const inputs = readSnapshot(source);
  const prepared: LegacyManifestPreparation = prepareLegacyManifest(inputs);
  const manifest = args.apply ? readApprovedManifest(args.manifest, prepared.manifest) : prepared.manifest;

  const imported: { path: string; artifact_id: string; revision: number | null }[] = [];
  const refused: { path: string; code: string; message: string }[] = [];
  if (args.apply && target !== null) {
    for (const row of manifest.rows) {
      const input = inputs.find((i) => i.path === row.path);
      if (!input) {
        refused.push({ path: row.path, code: "MISSING_INPUT", message: `the approved manifest names ${row.path}, which is not in the snapshot` });
        continue;
      }
      const outcome = await mutate({
        root: target, auth: { owner_id: ownerId, actor: "tenant-info-migrate" },
        policy: legacyImportPolicy, request: legacyImportRequest(ownerId, manifest, row, input.bytes),
      });
      if (outcome.committed === true) imported.push({ path: row.path, artifact_id: outcome.artifact_id, revision: outcome.revision });
      else refused.push({ path: row.path, code: outcome.code, message: outcome.message });
    }
  }

  const parity = target === null
    ? manifest.rows.map((row) => ({ path: row.path, sha256: row.sha256, byte_length: row.byte_length, archived: false, blob_present: false, bytes_match: false }))
    : parityOf(target, manifest.rows);
  const parityComplete = target !== null && parity.every((p) => p.bytes_match);

  const manifestPath = writeProtected(workspaceReal, "migration-manifest.json", manifest);
  const reports = [
    writeProtected(workspaceReal, "classification.json", classifyMigration(manifest, source)),
    writeProtected(workspaceReal, "parity.json", { mode: args.apply ? "apply" : "dry-run", manifest_id: manifest.manifest_id, rows: parity }),
  ];

  const receipt: MigrateReceipt = {
    verb: "migrate",
    mode: args.apply ? "apply" : "dry-run",
    source,
    target,
    manifest_id: manifest.manifest_id,
    manifest_path: relative(workspaceReal, manifestPath),
    input_count: inputs.length,
    row_count: manifest.rows.length,
    blocking: prepared.blocking,
    imported,
    refused,
    parity_complete: parityComplete,
    // A DRY RUN IS OK WHEN NOTHING BLOCKS IT. An apply additionally has to have imported every
    // row and matched every byte back out of the target — anything less is a cutover that did
    // not happen, however many rows it did carry.
    ok: prepared.blocking.length === 0 && refused.length === 0 && (!args.apply || parityComplete),
    reports: [manifestPath, ...reports].map((p) => relative(workspaceReal, p)),
    plannedAt: new Date().toISOString(),
  };
  writeProtected(workspaceReal, "migration.json", receipt);
  return receipt;
}

function requireOwner(owner: string | undefined): string {
  if (owner === undefined || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner)) {
    throw new CliError("INVALID_ARGUMENTS", "--apply requires --owner UUID, the owner the target volume holds.");
  }
  return owner;
}

/**
 * The approved manifest, read and CHECKED AGAINST THE SNAPSHOT IT CLAIMS TO DESCRIBE. A
 * manifest whose id no longer matches what the source actually contains is exactly the
 * "altered source hash" the contract makes a blocking error: the bytes changed after the
 * manifest was approved, and approving one set of bytes never approves another.
 */
function readApprovedManifest(path: string | undefined, fromSnapshot: LegacyConversionManifest): LegacyConversionManifest {
  if (path === undefined) throw new CliError("INVALID_ARGUMENTS", "--apply requires --manifest PATH.");
  if (!existsSync(path)) throw new CliError("INVALID_ARGUMENTS", `--manifest "${path}" does not exist.`);
  const approved = JSON.parse(readFileSync(path, "utf8")) as LegacyConversionManifest;
  if (approved.format_version !== LEGACY_MANIFEST_FORMAT_VERSION) {
    throw new CliError("INVALID_ARGUMENTS", `--manifest declares format ${String(approved.format_version)}; this migrator reads ${LEGACY_MANIFEST_FORMAT_VERSION}.`);
  }
  if (approved.manifest_id !== fromSnapshot.manifest_id) {
    throw new CliError(
      "INVALID_ARGUMENTS",
      `the approved manifest ${approved.manifest_id} does not describe this snapshot, which prepares as ${fromSnapshot.manifest_id} — ` +
      "the source bytes changed after the manifest was approved.",
    );
  }
  return approved;
}
