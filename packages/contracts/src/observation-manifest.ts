/**
 * observation-manifest.ts — what a piece of work left behind, captured as a baseline manifest, a
 * final manifest, the change between them, and the frozen state of every declared check.
 *
 * THE ONE INVARIANT THIS FILE EXISTS FOR: completeness is reported, never assumed. Every way this
 * capture can fall short of "here is everything the work did" lands in {@link CaptureReason} and
 * moves {@link ManifestCapture.completeness} off `complete`. Nothing is dropped quietly, and the
 * record never reads, later and to someone who was not there, like a capture that saw everything.
 *
 * AN IGNORED OUTPUT IS STILL AN OUTPUT. The walk underneath this file never consults git — see
 * `observation-walk.ts` for why and for the proof obligation that comes with it. A generated
 * bundle, a build artifact or a report written outside version control is part of what the work
 * did, and a manifest that omitted them would be silently incomplete while looking whole.
 *
 * WHY `includesIgnored` IS COMPUTED AND NOT DECLARED. The flag is a reduction over the exclusion
 * rules actually in force and the skips actually recorded: it is true because no rule and no skip
 * came from git's ignore list. A `true` written into the record would keep saying so on the day
 * somebody adds ignore filtering underneath it, which is the failure mode this whole capture is
 * about. `ManifestCaptureOptions.includeIgnored` is typed `true` on purpose — the module does not
 * implement ignore filtering, so asking for it is a compile error rather than a request that
 * would have to be refused at runtime.
 *
 * THE CAPTURE GOES THROUGH THE RUNTIME ADAPTER, NOT BESIDE IT. When the caller names the work,
 * it names it as {@link ObservedWork}: an identifier and the port's own `observe` operation,
 * together in one field so neither half can arrive without the other. What that observation says
 * is carried into the record rather than interpreted away — a final manifest taken while the
 * runtime reports the work still `running` is provably not final, and the record says so instead
 * of presenting a mid-flight snapshot as a result.
 *
 * AN INDEPENDENT RERUN PROVES ITS OWN RESULT NOW. Nothing here is cached and no manifest is
 * carried between calls. A capture with no supplied baseline takes one now, reports
 * `baselineSource` as such, and records that no change set could be established — because a
 * baseline read at the same instant as the final manifest can only ever report nothing changed.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Observation, RuntimeAdapter } from "./adapters/port.js";
import { asCheckState, type CheckState } from "./check-state.js";
import {
  DEFAULT_CAPTURE_LIMITS,
  walkRoots,
  type CaptureLimits,
  type FileManifest,
  type ManifestExclusion,
} from "./observation-walk.js";

/**
 * How much of "everything the work did" this record actually holds.
 *
 * The line between the two shortfalls is whether a reader can tell what is missing:
 *
 *   complete    the declared roots were read whole, against a baseline somebody supplied, with
 *               a runtime observation that confirmed the work had ended.
 *   bounded     something was left out or weakened AND the record names exactly what — a named
 *               directory excluded, a large file carrying a stamp instead of a content hash, no
 *               prior baseline, no runtime named. A reader can see the shape of the gap.
 *   incomplete  something is missing that this record cannot enumerate — a root that would not
 *               open, a walk that stopped at a safety valve, or a runtime that says the work has
 *               not finished. The gap has no known shape.
 *
 * `bounded` is not a softer `incomplete` and must never be read as `complete`. It is the answer
 * for a capture that stated its own limits, which is the whole of what this vocabulary buys.
 */
type CaptureCompleteness = "complete" | "bounded" | "incomplete";

/** Every way a capture can fall short, each one landing in the record rather than nowhere. */
type CaptureReasonKind =
  /** A named directory was not descended into. The record names it. */
  | "excluded"
  /** Entries above the content-hash size carry a stamp over size and modification time. */
  | "hash_strength"
  /** No baseline was supplied, so no change between two moments can be shown. */
  | "no_prior_baseline"
  /** No runtime was named, so the capture says nothing about whether the work had ended. */
  | "runtime_not_observed"
  /** The runtime reported an outcome other than finishing. The manifest is still final. */
  | "work_did_not_finish"
  /** A declared root or an entry under one could not be read. */
  | "inaccessible"
  /** A subtree below the depth valve was never walked and cannot be enumerated. */
  | "depth_capped"
  /** The file valve stopped the walk part way. What was not reached is unknown. */
  | "file_cap"
  /** The caller asked for ignored outputs and an exclusion in force hides them anyway. */
  | "ignored_outputs_hidden"
  /** The adapter could not look at the work. Distinct from looking and seeing nothing. */
  | "observation_unavailable"
  /** The runtime says the work is still going, so this final manifest is not final. */
  | "work_still_running"
  /** Activity stopped. That is the whole finding: not finished, not failed. */
  | "activity_only"
  /** More unreadable paths existed than this record lists. */
  | "reasons_truncated"
  /** The supplied baseline was taken under different terms, so no change can be compared. */
  | "baseline_mismatch";

/**
 * One shortfall, with the path it is about when it is about one and the count when it stands for
 * many. Stamped entries and excluded directories aggregate into a single reason with a count —
 * one reason per file would bury the reasons that name a single unreadable path.
 */
interface CaptureReason {
  readonly kind: CaptureReasonKind;
  readonly detail: string;
  readonly path?: string;
  readonly count?: number;
}

/**
 * The shortfalls whose shape a reader cannot recover from this record. Listed rather than
 * decided per site, so `completeness` is one reduction over the reasons actually present and not
 * a flag somebody remembered to set.
 */
const UNKNOWABLE_GAPS: readonly CaptureReasonKind[] = Object.freeze([
  "inaccessible",
  "depth_capped",
  "file_cap",
  "ignored_outputs_hidden",
  "observation_unavailable",
  "work_still_running",
  "activity_only",
  "reasons_truncated",
  "baseline_mismatch",
]);

/** At most this many unreadable paths are named individually; the rest become one counted
 *  reason, because a truncation nobody mentions is the defect this module is about. */
const MAX_NAMED_FAILURES = 50;

/** The one exclusion shipped by default. `.git` is not an output of the work — it is the store
 *  the outputs would be recorded in — and excluding it by name is a statement the record makes,
 *  not an ignore rule it consulted. */
const DEFAULT_EXCLUSIONS: readonly ManifestExclusion[] = Object.freeze([
  Object.freeze({
    directoryName: ".git",
    source: "declared_exclusion" as const,
    why: "git's own object store is not an output of the work, and walking it would hash the "
      + "repository's entire history on every capture",
  }),
]);

/** A check the work declared, and whatever the caller knows about its result. */
interface DeclaredCheckInput {
  readonly id: string;
  /** Where the check's source lives, when the caller knows. Read to freeze its hash. */
  readonly path?: string;
  /** The observed state, as data. Anything unrecognised becomes `unknown` — see
   *  {@link asCheckState}. Absent is different from present-and-undetermined. */
  readonly result?: unknown;
}

/**
 * One check as this capture froze it.
 *
 * `hash` is frozen in the sense that matters: taken once, at capture time, over the check's
 * SOURCE where the source could be read and over its DECLARATION where it could not, with
 * `hashedOver` saying which. It never moves with the result — a check that passes and then fails
 * has the same hash, which is what makes "the same check ran" a question the record can answer.
 */
interface CapturedCheck {
  readonly id: string;
  readonly path: string | null;
  readonly hash: string;
  readonly hashedOver: "source" | "declaration";
  readonly state: CheckState;
  readonly why: string;
}

/** How one path differs between the two manifests. `unchanged` is not a member: unchanged paths
 *  are counted, not listed, and the acceptance criterion asks for the ones that changed. */
interface FileChange {
  readonly path: string;
  readonly change: "added" | "modified" | "removed";
}

/** The work whose outputs are being captured, named the only way this capture accepts it: an
 *  identifier together with the port's own `observe`, so the identifier can never arrive
 *  without the operation that can say anything about it. */
interface ObservedWork {
  readonly id: string;
  readonly observe: RuntimeAdapter["observe"];
}

export interface ManifestCaptureOptions {
  /** The declared roots, spelled as they should appear in the manifest's keys. */
  readonly roots: readonly string[];
  /** Typed `true` because `false` is not implementable here — this module has no ignore-rule
   *  engine to switch on. Supplying it asserts the caller's requirement; the record answers
   *  with the measured {@link ManifestCapture.includesIgnored}, which is a different field. */
  readonly includeIgnored?: true;
  /** A manifest captured before the work ran. Without one, no change can be established. */
  readonly baseline?: FileManifest;
  readonly checks?: readonly DeclaredCheckInput[];
  /**
   * A result for a check the caller did not name, and the default result for declared checks
   * that carry none.
   *
   * PRESENCE IS THE SIGNAL, deliberately: `{ roots }` says nothing about checks and yields no
   * check records, while `{ roots, checkResult: undefined }` is a caller offering a result it
   * does not have, which is a fact worth keeping. The second synthesises one check whose state
   * is `unknown`, because {@link asCheckState} maps an unrecognised value to the one honest
   * answer. A capture that silently discarded the offer would leave the strongest rule this
   * task has — never `passed`, never `failed` — with nothing in the record exercising it.
   */
  readonly checkResult?: unknown;
  readonly work?: ObservedWork;
  readonly exclusions?: readonly ManifestExclusion[];
  readonly limits?: Partial<CaptureLimits>;
}

export interface ManifestCapture {
  /** The runtime's own observation stamp when there is one, otherwise this machine's clock. */
  readonly at: string;
  readonly work_id: string | null;
  /** Measured, not declared: true because no rule and no skip in this walk came from git's
   *  ignore list. See the file header. */
  readonly includesIgnored: boolean;
  readonly baseline: FileManifest;
  readonly final: FileManifest;
  readonly baselineSource: "supplied" | "captured_now";
  /** Only the paths that differ. {@link ManifestCapture.unchanged} counts the rest. */
  readonly changes: readonly FileChange[];
  readonly unchanged: number;
  readonly checks: readonly CapturedCheck[];
  /** Exactly what the port returned, unedited. Null when no work was named. */
  readonly observation: Observation | null;
  readonly completeness: CaptureCompleteness;
  readonly reasons: readonly CaptureReason[];
}

/** Freeze one declared check: its hash, and the state the record can actually establish. */
function captureCheck(
  input: DeclaredCheckInput,
  fallback: { readonly offered: boolean; readonly value: unknown },
): CapturedCheck {
  const hasResult = "result" in input || fallback.offered;
  const result = "result" in input ? input.result : fallback.value;

  let source: string | null = null;
  if (input.path !== undefined) {
    try {
      source = readFileSync(input.path, "utf8");
    } catch {
      source = null;
    }
  }
  const present = source !== null;
  const hash = source !== null
    ? `sha256:${createHash("sha256").update(source).digest("hex")}`
    : `declaration:${createHash("sha256").update(`${input.id}|${input.path ?? ""}`)
        .digest("hex")}`;

  // The three branches are the whole distinction this vocabulary carries. A result the caller
  // offered is read as data and lands wherever `asCheckState` puts it — which is `unknown` for
  // anything unrecognised, and never `passed` and never `failed`. With no result offered, the
  // record can still state a fact about ITSELF: the file is there, or only the name is.
  let state: CheckState;
  let why: string;
  if (hasResult) {
    state = asCheckState(result);
    why = state === "unknown"
      ? "a result was offered for this check and it does not determine which state the check "
        + "reached, so the record says so rather than choosing one"
      : "the caller reported this state for the check and the record carries it as reported";
  } else if (present) {
    state = "present";
    why = "the check's source was read at the declared path; nothing here ran it";
  } else {
    state = "declared";
    why = input.path === undefined
      ? "the check was named without a path, so nothing has been looked for"
      : "the check names a path that could not be read, so only the declaration is established";
  }

  return { id: input.id, path: input.path ?? null, hash, hashedOver: present ? "source" : "declaration", state, why };
}

/**
 * The digest of the terms a manifest was taken under, so two manifests can say whether they are
 * comparable at all. Written out in a fixed order rather than through a generic stable
 * stringifier: the fields are known here, and an order that cannot drift needs no sorter.
 */
function schemeOf(
  roots: readonly string[],
  limits: CaptureLimits,
  exclusions: readonly ManifestExclusion[],
): string {
  const terms = [
    `roots=${[...roots].sort().join(",")}`,
    `contentHashBytes=${limits.contentHashBytes}`,
    `maxDepth=${limits.maxDepth}`,
    `maxFiles=${limits.maxFiles}`,
    `exclusions=${exclusions.map((e) => `${e.directoryName}/${e.source}`).sort().join(",")}`,
  ].join("|");
  return createHash("sha256").update(terms).digest("hex").slice(0, 16);
}

/** Compare two manifests path by path. Both directions, so a removal is as visible as an
 *  addition — a capture that only reported what appeared would miss a deleted output. */
function classifyChanges(
  baseline: Readonly<Record<string, string>>,
  final: Readonly<Record<string, string>>,
): { readonly changes: FileChange[]; readonly unchanged: number } {
  const changes: FileChange[] = [];
  let unchanged = 0;
  for (const [path, hash] of Object.entries(final)) {
    const before = baseline[path];
    if (before === undefined) changes.push({ path, change: "added" });
    else if (before !== hash) changes.push({ path, change: "modified" });
    else unchanged += 1;
  }
  for (const path of Object.keys(baseline)) {
    if (!(path in final)) changes.push({ path, change: "removed" });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { changes, unchanged };
}

/** Everything the runtime observation adds to the record, in the port's own four arms. Each arm
 *  is answered separately, because collapsing them is how "the feed went quiet" starts reading
 *  like "the work finished". */
function readObservation(observation: Observation): CaptureReason[] {
  switch (observation.completeness) {
    case "receipt_confirmed":
      return observation.receipt.exit === "finished" ? [] : [{
        kind: "work_did_not_finish",
        detail: `the runtime's end-of-work record reports the work ${observation.receipt.exit}; `
          + "the manifests below are final, and what they hold is what a run that did not "
          + "finish left behind",
      }];
    case "running":
      return [{
        kind: "work_still_running",
        detail: "the runtime reports the work is still going, so this final manifest is a "
          + "mid-flight snapshot and cannot name the outputs still to be written",
      }];
    case "last_activity_only":
      return [{
        kind: "activity_only",
        detail: "the runtime's feed went quiet and issued no end-of-work record, which "
          + "establishes that activity stopped and nothing about whether the work finished",
      }];
    case "observation_unavailable":
      return [{
        kind: "observation_unavailable",
        detail: "the adapter could not look at the work, so nothing here says whether the "
          + "outputs captured are all of them",
      }];
  }
}

/**
 * Capture what the declared roots hold now, what changed since a baseline, and the frozen state
 * of every declared check.
 *
 * Synchronous and uncached by design: a capture is a statement about a moment, and a moment that
 * arrives from somewhere else is somebody else's moment.
 */
export function captureManifest(options: ManifestCaptureOptions): ManifestCapture {
  const limits: CaptureLimits = { ...DEFAULT_CAPTURE_LIMITS, ...options.limits };
  const exclusions = options.exclusions ?? DEFAULT_EXCLUSIONS;
  const walked = walkRoots(options.roots, limits, exclusions);
  const reasons: CaptureReason[] = [];

  // The measured flag. Both halves are reductions over real data: the rules in force, and the
  // skips those rules actually produced. Neither is a literal, and either one turning up a git
  // source is enough to say the record hides generated outputs.
  const includesIgnored =
    exclusions.every((rule) => rule.source !== "git_ignore")
    && walked.skips.every((skip) => skip.source !== "git_ignore");

  for (const failure of walked.failures.slice(0, MAX_NAMED_FAILURES)) {
    reasons.push({ kind: "inaccessible", path: failure.path, detail: failure.why });
  }
  if (walked.failures.length > MAX_NAMED_FAILURES) {
    reasons.push({
      kind: "reasons_truncated",
      count: walked.failures.length - MAX_NAMED_FAILURES,
      detail: "more paths could not be read than this record names individually",
    });
  }
  if (walked.skips.length > 0) {
    reasons.push({
      kind: "excluded",
      count: walked.skips.length,
      detail: `directories were not descended into by name: ${
        [...new Set(walked.skips.map((s) => s.detail))].join("; ")}`,
    });
  }
  if (walked.stamped.length > 0) {
    reasons.push({
      kind: "hash_strength",
      count: walked.stamped.length,
      detail: `entries larger than ${limits.contentHashBytes} bytes carry a stamp over size and `
        + "modification time instead of a content hash, so an edit that changed neither is "
        + "invisible to this record",
    });
  }
  for (const path of walked.depthCapped) {
    reasons.push({
      kind: "depth_capped",
      path,
      detail: `the walk stopped at depth ${limits.maxDepth}; what lies below is not enumerated`,
    });
  }
  if (walked.fileCapHit) {
    reasons.push({
      kind: "file_cap",
      count: walked.filesSeen,
      detail: `the walk stopped after ${limits.maxFiles} files; the roots hold more than this `
        + "record names and what was not reached cannot be listed",
    });
  }
  if (options.includeIgnored === true && !includesIgnored) {
    reasons.push({
      kind: "ignored_outputs_hidden",
      detail: "the caller required outputs git ignores to be captured, and an exclusion in "
        + "force consults git's ignore list, so generated outputs are missing from the manifest",
    });
  }

  // Through the port, or not at all. There is no fallback observation: a capture with no runtime
  // named says so and stays a statement about the filesystem, rather than answering about a
  // process it was never given.
  let observation: Observation | null = null;
  if (options.work) {
    observation = options.work.observe({ work_id: options.work.id });
    reasons.push(...readObservation(observation));
  } else {
    reasons.push({
      kind: "runtime_not_observed",
      detail: "no runtime adapter was named, so this capture reports the filesystem and says "
        + "nothing about whether the work that wrote it had ended",
    });
  }

  const at = observation?.observed_at ?? new Date().toISOString();
  const scheme = schemeOf(options.roots, limits, exclusions);
  const final: FileManifest = { at, roots: [...options.roots], scheme, entries: walked.entries };
  const baseline = options.baseline ?? final;
  const baselineSource = options.baseline ? "supplied" : "captured_now";
  if (baselineSource === "captured_now") {
    reasons.push({
      kind: "no_prior_baseline",
      detail: "no baseline was supplied, so the baseline below was taken at the same moment as "
        + "the final manifest and no change between two moments is established by this record",
    });
  }
  // A baseline taken under other terms is not a baseline for these manifests, and comparing the
  // two would produce a change set that is wrong while reading as established — every large
  // file `modified` because the hashing threshold moved, or a whole excluded subtree `added`.
  // The comparison is refused rather than published: no changes, and the record says why.
  const comparable = baseline.scheme === final.scheme;
  if (!comparable) {
    reasons.push({
      kind: "baseline_mismatch",
      detail: `the supplied baseline was taken under terms ${baseline.scheme} and this capture `
        + `under ${scheme} — different roots, bounds or exclusions — so what changed between `
        + "them cannot be established and no change set is reported",
    });
  }
  const { changes, unchanged } = comparable
    ? classifyChanges(baseline.entries, final.entries)
    : { changes: [] as FileChange[], unchanged: 0 };

  const declared = options.checks ?? [];
  const offered = "checkResult" in options;
  const fallback = { offered, value: options.checkResult };
  const checks: CapturedCheck[] = declared.map((input) => captureCheck(input, fallback));
  if (checks.length === 0 && offered) {
    checks.push(captureCheck({ id: "unnamed-check", result: options.checkResult }, fallback));
  }

  const completeness: CaptureCompleteness = reasons.some((r) => UNKNOWABLE_GAPS.includes(r.kind))
    ? "incomplete"
    : reasons.length > 0 ? "bounded" : "complete";

  return {
    at,
    work_id: options.work?.id ?? null,
    includesIgnored,
    baseline,
    final,
    baselineSource,
    changes,
    unchanged,
    checks,
    observation,
    completeness,
    reasons,
  };
}
