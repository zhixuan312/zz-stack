/**
 * inventory.ts — the `fixtures` verb: the seven declared corpora, the deterministic generator
 * behind them, and the arithmetic that refuses a scale it cannot honour.
 *
 * THE EDIT-SURFACE LEDGER MOVED OUT DURING I-3, into ledger.ts, and which half moved was not a
 * free choice. This file was 698 lines of a measured, unexemptable 700-line ceiling with I-13's
 * migration-name validation still owed to it, so something had to go — but two frozen
 * plan-authored checks import `planCorpora`, `textFixture` and `validateMigrationNames` from
 * THIS path by name, and a frozen check is not editable. So the symbols the checks pin stay and
 * the ledger, which no check imports, is what left. Splitting the other way looked tidier and
 * broke a check on the first run.
 *
 * NOTHING HERE READS REAL CONTENT. Every byte a corpus contains is invented from a seed, because
 * these fixtures stand in for private team documents: a generator that sampled real material
 * would put tenant content into an acceptance corpus and from there into a benchmark report.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "./errors.ts";
import { safeWritePath } from "./workspace.ts";
interface FixturesArgs { seed: number; scale: string }

const GENERATOR_VERSION = "1";
const ONE_MIB = 1048576;

/** `planCorpora`'s own refusal, distinct from `CliError`: a fractional fixture count is a
 *  property of the PLAN, not of one invocation, so it needs its own stable `code`. */
class FractionalFixtureCountError extends Error {
  readonly code = "FRACTIONAL_FIXTURE_COUNT" as const;
}

interface CorpusPlan { readonly records: number; readonly one_mib: number }

/** The seven declared corpora's full-scale (`scale: 1`) record counts — matches the committed
 *  public DEFINITION at `testing/tenant-info/manifest.json`, never a private run's numbers.
 *  `1500` is fixed by that same definition: one 1-MiB fixture per 1500 records, every corpus,
 *  every scale. */
const BASE_CORPORA: Readonly<Record<string, number>> = {
  primary_current: 150000, primary_evidence: 150000, primary_history: 150000,
  other_team_a: 150000, other_team_b: 150000,
  shared_current: 15000, shared_evidence: 15000,
};

/** `base * scale` can land a few ULPs off an integer even when the true answer is exact — a
 *  tolerance, not raw `Number.isInteger`, is what tells a valid reduced scale apart from one
 *  that actually produces a fractional fixture count. */
const isWholeNumber = (n: number): boolean => Math.abs(n - Math.round(n)) < 1e-9;

/**
 * Each corpus's `{records, one_mib}` at `scale` (1 is full scale: 780,000 records including
 * 520 exactly-1-MiB fixtures). A scale outside `(0, 1]` is an invalid invocation; a scale that
 * leaves any single corpus with a fractional record or fixture count is refused separately —
 * a reduced-scale corpus that rounds quietly is a different, undeclared corpus.
 */
export function planCorpora(scale: number): Record<string, CorpusPlan> {
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
    throw new CliError("INVALID_ARGUMENTS", `scale must be a finite number in (0, 1], got ${scale}.`);
  }
  const plan: Record<string, CorpusPlan> = {};
  for (const [corpus, base] of Object.entries(BASE_CORPORA)) {
    const records = base * scale;
    const oneMib = records / 1500;
    if (!isWholeNumber(records) || !isWholeNumber(oneMib)) {
      throw new FractionalFixtureCountError(
        `scale ${scale} gives corpus "${corpus}" ${records} records / ${oneMib} one-MiB fixtures — not integral.`,
      );
    }
    plan[corpus] = { records: Math.round(records), one_mib: Math.round(oneMib) };
  }
  return plan;
}

// ─────────────────────────────── deterministic fixture text ───────────────────────────────

interface TextFixtureRequest {
  readonly seed: number; readonly ordinal: number; readonly bytes: number;
  readonly language: "en" | "zh" | "mixed";
}

/** mulberry32 — small, deterministic, no dependency; a repeatable stream, not crypto. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit seed from a string key (FNV-1a), so `seed`/`ordinal`/`language` combine into one
 *  PRNG state without the collisions naive addition would give (seed=1,ordinal=23 vs
 *  seed=2,ordinal=13 under plain `seed+ordinal`). */
function seedFrom(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const EN_WORDS = [
  "initiative", "document", "knowledge", "revision", "provenance", "tenant", "corpus", "fixture",
  "retrieval", "isolation", "migration", "rebuild", "projection", "analysis", "benchmark", "manifest",
  "baseline", "workspace", "artifact", "concept", "negative", "boundary", "edge", "case", "version",
  "deprecated", "superseded", "glossary", "appendix", "threshold", "checkpoint", "ledger", "witness",
];
const EN_BYTES = EN_WORDS.map((w) => Buffer.byteLength(w, "utf8"));

/** One deterministic codepoint from the CJK Unified Ideographs block (U+4E00-U+9FFF, always
 *  3 bytes in UTF-8) — 20,992 of them is enough range that text does not visibly repeat. */
function zhChar(rand: () => number): string {
  return String.fromCodePoint(0x4e00 + Math.floor(rand() * 0x5200));
}

/**
 * The deterministic generator behind every fixture record: the same request always returns
 * the same string, exactly `bytes` UTF-8 bytes long. Content is drawn word-at-a-time until
 * the next chunk would overshoot, then an ASCII `.` run — always 1 byte each — closes the
 * exact remainder a word-at-a-time fill cannot land on precisely.
 */
export function textFixture(req: TextFixtureRequest): string {
  const rand = mulberry32(seedFrom(`${req.seed}:${req.ordinal}:${req.language}`));
  let out = "";
  let usedBytes = 0;
  while (usedBytes < req.bytes) {
    const wantsEn = req.language === "en" || (req.language === "mixed" && rand() < 0.5);
    let chunk: string;
    let chunkBytes: number;
    if (wantsEn) {
      const i = Math.floor(rand() * EN_WORDS.length);
      chunk = out.length === 0 ? EN_WORDS[i] : ` ${EN_WORDS[i]}`;
      chunkBytes = (out.length === 0 ? 0 : 1) + EN_BYTES[i];
    } else {
      chunk = zhChar(rand);
      chunkBytes = 3;
    }
    if (usedBytes + chunkBytes > req.bytes) break;
    out += chunk;
    usedBytes += chunkBytes;
  }
  return out + ".".repeat(req.bytes - usedBytes);
}

// ─────────────────────────────── corpus generation and manifest ───────────────────────────

interface CorpusManifestEntry {
  readonly record_count: number; readonly one_mib_fixture_count: number;
  readonly mean_bytes: number; readonly p95_bytes: number; readonly total_bytes: number;
  readonly histogram: Readonly<Record<string, number>>;
  readonly file_hashes: readonly string[]; readonly hash: string;
}

// Upper bound `ONE_MIB - 1`, not `ONE_MIB`, so an exactly-1-MiB fixture (`size <= max`) lands
// in the "1MiB" bucket rather than being counted as merely under it.
const HISTOGRAM_BUCKETS: readonly (readonly [number, string])[] = [
  [1024, "<1KiB"], [4096, "1-4KiB"], [16384, "4-16KiB"], [65536, "16-64KiB"],
  [262144, "64-256KiB"], [ONE_MIB - 1, "256KiB-1MiB"], [Infinity, "1MiB"],
];

function histogramOf(sizes: readonly number[]): Record<string, number> {
  const hist: Record<string, number> = {};
  for (const [, label] of HISTOGRAM_BUCKETS) hist[label] = 0;
  for (const size of sizes) {
    const [, label] = HISTOGRAM_BUCKETS.find(([max]) => size <= max) ?? HISTOGRAM_BUCKETS[HISTOGRAM_BUCKETS.length - 1];
    hist[label]++;
  }
  return hist;
}

/**
 * Non-1-MiB record size, calibrated by Monte-Carlo simulation (see the task report, not
 * asserted by a check here) so a full corpus's OVERALL mean/p95, 1-MiB fixtures included,
 * land within 5% of the full-scale target (8192 / 65536 bytes). Two overlapping bands rather
 * than one lognormal — a single lognormal cannot reach a p95/mean ratio of 8 without an
 * unrealistically fat body — with the 65536 boundary INSIDE the large band's range rather
 * than at its edge, so the empirical p95 does not hinge on which side of a hard cutoff
 * sampling noise lands on. I-23 measures the real generated store; this only approximates it.
 */
function sampleBodyBytes(rand: () => number): number {
  return rand() < 0.918
    ? 256 + Math.floor(rand() * 3320)     // small: 256B-3.6KiB — most records
    : 50000 + Math.floor(rand() * 40000); // large: 50-90KiB — straddles the 65536 p95 target
}

/**
 * Generates one corpus's fixture files under `dir` (inside the validated workspace) and
 * returns its measured manifest entry. These are Phase 1 records — neutral, seed-derived text
 * with a predetermined identifier, not a native committed platform transaction; loading them
 * through the fixture/import adapter is later work, once the kernel and projections exist.
 */
function generateCorpus(
  dir: string, corpus: string, seed: number, records: number, oneMib: number,
): CorpusManifestEntry {
  mkdirSync(dir, { recursive: true });
  const rand = mulberry32(seedFrom(`${seed}:${corpus}`));
  const sizes: number[] = [];
  const hashes: string[] = [];
  const languages = ["en", "zh", "mixed"] as const;
  for (let ordinal = 0; ordinal < records; ordinal++) {
    const bytes = ordinal < oneMib ? ONE_MIB : sampleBodyBytes(rand);
    const text = textFixture({ seed, ordinal, bytes, language: languages[ordinal % languages.length] });
    writeFileSync(join(dir, `${corpus}-${String(ordinal).padStart(6, "0")}.txt`), text);
    sizes.push(bytes);
    hashes.push(createHash("sha256").update(text).digest("hex"));
  }
  const sorted = [...sizes].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1))];
  const totalBytes = sizes.reduce((a, b) => a + b, 0);
  return {
    record_count: records,
    one_mib_fixture_count: oneMib,
    mean_bytes: Math.round(totalBytes / records),
    p95_bytes: p95,
    total_bytes: totalBytes,
    histogram: histogramOf(sizes),
    file_hashes: hashes,
    hash: createHash("sha256").update(hashes.join("\n")).digest("hex"),
  };
}

interface FixturesReceipt {
  readonly verb: "fixtures"; readonly seed: number; readonly scale: number;
  readonly generatedAt: string; readonly generator_version: string;
  readonly total_records: number; readonly total_bytes: number; readonly manifest_path: string;
  readonly corpora: Readonly<Record<string, Omit<CorpusManifestEntry, "file_hashes">>>;
}

/**
 * Generates the seven declared corpora at `args.scale` under the validated workspace and
 * writes the full measured manifest there — `<workspace>/fixtures-manifest.json`, never into
 * this repository. That file, not the committed `testing/tenant-info/manifest.json` (the
 * public DEFINITION this generator is built from, not a run's output), is where
 * `file_hashes` and each corpus's aggregate hash actually live. The returned receipt carries
 * the same per-corpus data minus `file_hashes`, which at full scale is tens of megabytes.
 */
export function runFixtures(workspaceReal: string, args: FixturesArgs): FixturesReceipt {
  const scale = Number(args.scale);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
    throw new CliError("INVALID_ARGUMENTS", `--scale must be a finite number in (0, 1], got "${args.scale}".`);
  }
  const plan = planCorpora(scale);
  const corpora: Record<string, CorpusManifestEntry> = {};
  for (const [corpus, { records, one_mib }] of Object.entries(plan)) {
    corpora[corpus] = generateCorpus(join(workspaceReal, corpus), corpus, args.seed, records, one_mib);
  }
  const totalRecords = Object.values(corpora).reduce((a, c) => a + c.record_count, 0);
  const totalBytes = Object.values(corpora).reduce((a, c) => a + c.total_bytes, 0);
  const generatedAt = new Date().toISOString();
  const full = {
    verb: "fixtures" as const, seed: args.seed, scale, generatedAt,
    generator_version: GENERATOR_VERSION, total_records: totalRecords, total_bytes: totalBytes, corpora,
  };
  const manifestPath = safeWritePath(workspaceReal, "fixtures-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(full, null, 2)}\n`);
  const summaryCorpora: Record<string, Omit<CorpusManifestEntry, "file_hashes">> = {};
  for (const [corpus, { file_hashes: _file_hashes, ...rest }] of Object.entries(corpora)) {
    summaryCorpora[corpus] = rest;
  }
  return {
    verb: "fixtures", seed: args.seed, scale, generatedAt, generator_version: GENERATOR_VERSION,
    total_records: totalRecords, total_bytes: totalBytes, manifest_path: manifestPath, corpora: summaryCorpora,
  };
}

// ─────────────────────────────── migration name validation ────────────────────────────────

const MIGRATION_NAME = /^(\d{3})_(.+)\.sql$/;

interface MigrationNameValidation {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * Two properties over a migration directory's actual filenames, asked at whatever moment the
 * caller likes: every three-digit numeric prefix is unique, and `slug` names EXACTLY one of
 * them. Neither is about ORDER — I-13's own contract says a migration need not remain the
 * largest number forever, so "did this land at the next free target-branch number" is a
 * separate, merge-time workflow check this function does not make. This one stays true
 * forever after a merge; that one is only ever asked of a migration not yet merged.
 *
 * A filename that is not `<NNN>_<anything>.sql` is reported and otherwise ignored for the
 * prefix-uniqueness count — it has no prefix to collide with anything.
 */
export function validateMigrationNames(filenames: readonly string[], slug: string): MigrationNameValidation {
  const problems: string[] = [];
  const byPrefix = new Map<string, string[]>();
  const namingSlug: string[] = [];
  for (const name of filenames) {
    const m = MIGRATION_NAME.exec(name);
    if (!m) {
      problems.push(`${name} is not a well-formed <NNN>_<slug>.sql migration filename`);
      continue;
    }
    const [, prefix, body] = m;
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), name]);
    if (body === slug) namingSlug.push(name);
  }
  for (const [prefix, names] of byPrefix) {
    if (names.length > 1) problems.push(`numeric prefix ${prefix} is reused by ${names.join(", ")}`);
  }
  if (namingSlug.length === 0) problems.push(`no migration names slug "${slug}"`);
  if (namingSlug.length > 1) {
    problems.push(`slug "${slug}" is named by more than one file: ${namingSlug.join(", ")}`);
  }
  return { ok: problems.length === 0, problems };
}

// ────────────────────────── edit-surface ownership ledger ──────────────────────────
