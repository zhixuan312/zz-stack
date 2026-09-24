/**
 * Running the negative-control probes.
 *
 * Nine modules in `@zz/contracts` exist to prove a detector can actually fail: each plants a
 * fault the real inputs cannot express, runs the real code over it, and reports whether the
 * detector noticed. A probe nothing runs proves nothing, so this file runs all nine.
 *
 * DELIBERATE: one check per probe, never one check over nine. `check` in `../run.ts` reports
 * the first failure string a body returns, so a loop would name one broken probe and hide
 * eight; `gateCheckNames` in `../read.ts` discovers names with `/^check\("(.+?)",/gm`, so a
 * name built in a loop is invisible to the gate's inventory and to the execution report.
 *
 * What each kind is asserted against differs:
 *
 *   · Five probes return self-verdicting rows — `fires` is a boolean the probe computed. The
 *     check asserts every row fires, the row count, distinct detector names, and that `fires`
 *     agrees with the prose on the same row, which is the only independent purchase here.
 *
 *   · `rebindDetectorProbe` returns one rolled-up boolean over nine named scenarios. The check
 *     asserts the roll-up, the nine names, and three discriminations it reads off the scenarios
 *     itself.
 *
 *   · Three probes return descriptive tables with no verdict in them. Their expected tables are
 *     restated here, keyed by variant name and never by index, because `commit-boundary.ts`
 *     builds two of its variants by slicing the real protocol.
 *
 * The counts are exact: a probe that loses rows still passes "every row fires", and an empty
 * one passes it vacuously.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditIdentityProbe, boundaryDetectorProbe, closeProbe, gapRoutingProbe, rebindDetectorProbe,
  recallTrialProbe, reconcileDetectorProbe, snapshotCoverageProbe, stageControlProbe,
} from "@zz/contracts";
import { firstOf, root, withoutComments } from "../read.ts";
import { check } from "../run.ts";

// The set itself, derived rather than typed

const DOOR = "packages/contracts/src/control-loop.ts";

/** The door's exported value names, with `X as Y` resolved to the name the door publishes.
 *  Type exports are dropped: `ProbeReport`, `CloseProbeRow` and their eight siblings all carry
 *  "Probe" in the name and none of them is a probe. */
function doorValueNames(source: string): string[] {
  const out: string[] = [];
  for (const block of source.matchAll(/export\s*\{([^}]*)\}\s*from\s*"[^"]+"/g)) {
    for (const raw of block[1].split(",")) {
      const piece = raw.trim();
      if (!piece || /^type\s/.test(piece)) continue;
      out.push((piece.split(/\s+as\s+/).pop() ?? piece).trim());
    }
  }
  return out;
}

/** The names this module imports from the door. `noUnusedLocals` is on for `scripts/**`, so a
 *  name that appears here is a name some check below actually calls — the compiler binds the
 *  import list to the exercised set, and this check does not have to. */
function ownProbeImports(source: string): string[] {
  const out: string[] = [];
  for (const block of source.matchAll(/import\s+\{([^}]*)\}\s*from\s*"@zz\/contracts"/g)) {
    for (const raw of block[1].split(",")) {
      const piece = raw.trim();
      if (piece) out.push(piece);
    }
  }
  return out;
}

/**
 * The set is derived, not typed, which is what makes the other nine checks trustworthy: it
 * comes off the door — every exported value name ending in `Probe` — and is compared against
 * the names this module imports. Add a probe to the door and this fails until it is wired;
 * delete one and this fails until the import goes.
 *
 * COUPLED: `noUnusedLocals` on `scripts/**` is doing half the work. An import no check below
 * calls fails the typecheck, which is what binds the import list to the exercised set.
 *
 * The `Probe` suffix is the convention, and a probe named against it would be missed, so the
 * convention is asserted by failing when the door yields no probes at all.
 */
check("every negative-control probe on the contracts door is run by this file", () => {
  const door = withoutComments(readFileSync(join(root, DOOR), "utf8"));
  const onDoor = doorValueNames(door).filter((n) => /Probe$/.test(n));
  // A door this check cannot read is a failure, not a pass on an empty set: the door moving or
  // changing shape would otherwise retire this rule silently.
  if (onDoor.length === 0) {
    return `${DOOR} yielded no exported value name ending in "Probe" — the door moved, changed ` +
      "shape, or the naming convention this check derives the set from has been abandoned";
  }
  const own = ownProbeImports(withoutComments(readFileSync(fileURLToPath(import.meta.url), "utf8")));
  const imported = new Set(own);
  const bad: string[] = [];
  for (const name of onDoor) {
    if (!imported.has(name)) {
      bad.push(`${DOOR} publishes the probe ${name} and this file does not run it — import it ` +
        "and add a check, or take it off the door; a probe nothing runs proves nothing");
    }
  }
  for (const name of own) {
    if (/Probe$/.test(name) && !onDoor.includes(name)) {
      bad.push(`this file imports ${name} and the door no longer publishes it as a value`);
    }
  }
  return firstOf(bad);
});


// The five probes that verdict their own rows

/** The row shape all five share. Declared here rather than imported because five modules
 *  export five structurally identical interfaces under five different names, and what this
 *  file needs is the shape rather than any one of the names. */
interface FiringRow {
  readonly detector: string;
  readonly healthy: string;
  readonly faulted: string;
  readonly fires: boolean;
}

/**
 * Every assertion a self-verdicting probe is held to. Returns the failure text, or null.
 *
 * DELIBERATE: emptiness is tested first, because an empty table satisfies "every row fires" —
 * `[].every` is true — and that vacuous pass is the shape these probes exist to expose.
 */
function firing(rows: readonly FiringRow[], expected: number): string | null {
  if (rows.length === 0) {
    return "the probe returned no rows at all. A probe with nothing to report satisfies " +
      "\"every row fires\" vacuously, which is precisely the shape it exists to catch";
  }
  if (rows.length !== expected) {
    return `the probe returned ${rows.length} rows where ${expected} were measured when this ` +
      "check was written. If rows were added or removed deliberately, update the number here; " +
      "if they were not, a detector has been lost";
  }
  const names = new Set(rows.map((r) => r.detector));
  if (names.size !== rows.length) {
    return `the ${rows.length} rows do not carry ${rows.length} distinct detector names ` +
      `(${names.size} distinct). Repeated rows inflate the count without testing anything further`;
  }
  const missed = rows.filter((r) => !r.fires);
  if (missed.length) {
    return `${missed.length} of ${rows.length} detectors did not fire: ` +
      missed.map((r) => `${r.detector} [${r.healthy}] [${r.faulted}]`).join("; ");
  }
  // The independent reading. `fires` is the probe's own conjunction; `healthy` and `faulted`
  // are the same two booleans rendered as prose by the same helper. A `fires` that no longer
  // follows from them is a verdict somebody wrote rather than one the probe measured.
  const inconsistent = rows.filter(
    (r) => !r.healthy.startsWith("silent") || !r.faulted.startsWith("fires"),
  );
  if (inconsistent.length) {
    return `the prose on ${inconsistent.length} of ${rows.length} rows contradicts the ` +
      "fires=true the same row carries: " +
      inconsistent.map((r) => `${r.detector} [${r.healthy}] [${r.faulted}]`).join("; ");
  }
  return null;
}

check("the audit-identity negative control fires on every planted fault", () =>
  firing(auditIdentityProbe(), 10));

check("the gap-routing negative control fires on every planted fault", () =>
  firing(gapRoutingProbe(), 21));

check("the close negative control fires on every planted fault", () =>
  firing(closeProbe(), 13));

check("the stage-control negative control fires on every planted fault", () =>
  firing(stageControlProbe(), 14));

check("the recall-trial negative control fires on every planted fault", () =>
  firing(recallTrialProbe(), 11));

// The probe that rolls its scenarios up into one boolean

check("the profile-rebind negative control fires on every planted fault", () => {
  const report = rebindDetectorProbe();
  const expected = ["clean", "sameRef", "rebadge", "looseKey", "reuseCache", "switchFirst",
    "wrongSlot", "incompatible", "rewriteHistory"];
  const present = Object.keys(report.scenarios);
  const missing = expected.filter((n) => !present.includes(n));
  if (missing.length) {
    return `scenarios the probe no longer runs: ${missing.join(", ")}. It ran ` +
      (present.length ? present.join(", ") : "none at all");
  }
  if (!report.everyDetectorFires) {
    return "the probe reports that not every detector fired across its nine scenarios: " +
      present.join(", ");
  }
  // Three discriminations read off the scenarios here, so `everyDetectorFires` — which the
  // probe computes about itself — is not the only thing this check stands on.
  const s = report.scenarios;
  if (s.clean.inheritedCalibration !== false || s.rebadge.inheritedCalibration !== true) {
    return "the calibration detector does not separate a clean rebind from a rebadge: " +
      `clean=${s.clean.inheritedCalibration}, rebadge=${s.rebadge.inheritedCalibration}`;
  }
  if (s.clean.reusedCachedAnswers !== false || s.reuseCache.reusedCachedAnswers !== true) {
    return "the cache detector does not separate a clean rebind from a kept cache: " +
      `clean=${s.clean.reusedCachedAnswers}, reuseCache=${s.reuseCache.reusedCachedAnswers}`;
  }
  if (s.clean.suspendedFirst !== true || s.switchFirst.suspendedFirst !== false) {
    return "the ordering detector does not separate suspending first from switching first: " +
      `clean=${s.clean.suspendedFirst}, switchFirst=${s.switchFirst.suspendedFirst}`;
  }
  return null;
});

// The three probes that return a table and leave the verdict to the reader

check("the commit-boundary negative control shows each field can come back the bad way", () => {
  const rows = boundaryDetectorProbe();
  /** Each variant, and the three contract fields as they must come back. The first is the real
   *  protocol and is the control; the rest each break one thing. Rows three and four are the
   *  pair a check reading either field alone would call clean. */
  const expected: readonly (readonly [string, boolean, readonly string[], boolean])[] = [
    ["the described protocol", true, ["permission_store", "document_store"], false],
    ["split_transaction", false, [], false],
    ["permission_read_outside_the_fence", true, ["document_store"], false],
    ["publish_store_unfenced", false, ["permission_store"], false],
    ["model_call_inside_the_fence", true, ["permission_store", "document_store"], true],
    ["backoff_inside_the_fence", true, ["permission_store", "document_store"], true],
  ];
  if (rows.length !== expected.length) {
    return `the probe returned ${rows.length} variants where ${expected.length} were measured ` +
      "when this check was written; if the change was deliberate, update this table";
  }
  for (const [variant, serialized, covers, holds] of expected) {
    const got = rows.find((r) => r.variant === variant);
    if (!got) return `the probe no longer returns the variant "${variant}"`;
    // `covers` is compared as a set: its order follows the protocol's steps, so an
    // order-sensitive comparison would fail on a reordering this check is not about.
    const gotCovers = [...got.covers].sort().join(",");
    const wantCovers = [...covers].sort().join(",");
    if (got.serialized !== serialized || gotCovers !== wantCovers
      || got.holdsLockAcrossModelCall !== holds) {
      return `variant "${variant}" came back serialized=${got.serialized} ` +
        `covers=[${gotCovers}] holdsLockAcrossModelCall=${got.holdsLockAcrossModelCall}; ` +
        `expected serialized=${serialized} covers=[${wantCovers}] ` +
        `holdsLockAcrossModelCall=${holds}`;
    }
  }
  // Each field must come back both ways somewhere in the table: a field constant across every
  // variant is indistinguishable from a field nothing computes.
  const both = (values: readonly boolean[]): boolean =>
    values.includes(true) && values.includes(false);
  if (!both(rows.map((r) => r.serialized))) return "serialized is constant across every variant";
  if (!both(rows.map((r) => r.holdsLockAcrossModelCall))) {
    return "holdsLockAcrossModelCall is constant across every variant";
  }
  if (!both(rows.map((r) => r.covers.length > 0))) {
    return "covers is non-empty for every variant, or empty for every variant";
  }
  return null;
});

check("the dependency-snapshot negative control shows the coverage audit can refuse", () => {
  const rows = snapshotCoverageProbe();
  /** Each arrangement, the finding it must produce, and the verdict that must follow. The first
   *  is the real declared set and is the control: no finding, and a valid verdict. `paused` is
   *  what makes the audit load-bearing rather than a report printed beside a grant that
   *  redeems anyway. `uncovered:1` is exact, because `uncovered:0` planted nothing. */
  const expected: readonly (readonly [string, string | null, string])[] = [
    ["the declared closed set against the contract clause", null, "valid"],
    ["one dependency dropped from the closed set", "clause_unclaimed:qualification", "paused"],
    ["a dependency the contract never names, added to the set", "phrase_absent:weather", "paused"],
    ["a snapshot missing an entry the closed set requires", "uncovered:1", "paused"],
  ];
  if (rows.length !== expected.length) {
    return `the probe returned ${rows.length} arrangements where ${expected.length} were ` +
      "measured when this check was written; if the change was deliberate, update this table";
  }
  for (const [arrangement, finding, verdict] of expected) {
    const got = rows.find((r) => r.arrangement === arrangement);
    if (!got) return `the probe no longer returns the arrangement "${arrangement}"`;
    if (got.verdict !== verdict) {
      return `"${arrangement}" came back ${got.verdict}; expected ${verdict}`;
    }
    if (finding === null && got.findings.length) {
      return "the real declared set produced findings it should not have: " +
        got.findings.join(", ");
    }
    if (finding !== null && !got.findings.includes(finding)) {
      return `"${arrangement}" should have produced the finding ${finding}; it produced ` +
        (got.findings.length ? got.findings.join(", ") : "none at all");
    }
  }
  return null;
});

check("the commit-reconciliation negative control shows each flag can come back the bad way", () => {
  const rows = reconcileDetectorProbe();
  /** Each variant: the state it must reach, the flags that must be raised, and the fields
   *  `invented` must name. Anything not listed must be false or empty — a planted fault that
   *  tripped a second flag would mean the four flags are not independent. The first four are
   *  the real plans, so the table shows the flags false on correct work rather than always. */
  const flags = ["invented", "replay", "substitutedEtag", "newIdempotencyKey"] as const;
  const expected: readonly (readonly [string, string, readonly string[], readonly string[]])[] = [
    ["the canonical no-op", "applied", [], []],
    ["a commit whose projection lags", "applied", [], []],
    ["a definite refusal", "failed", [], []],
    ["an unknown commit", "reconciling", [], []],
    ["no_op_defaults_the_commit_sequence", "applied", ["invented"], ["commit_sequence"]],
    ["no_op_mints_a_transaction_id", "applied", ["invented"], ["transaction_id"]],
    ["lagging_commit_alters_the_revision", "applied", ["invented"], ["revision"]],
    ["unknown_step_mints_a_transaction_id", "reconciling", ["invented"], ["transaction_id"]],
    ["control_record_repaired_by_re_running_it", "applied", ["replay"], []],
    ["durable_write_resent_with_its_own_etag", "applied", ["replay"], []],
    ["stale_etag_resent_with_the_newest_etag", "failed", ["substitutedEtag"], []],
    ["unknown_redispatched_under_a_new_key", "reconciling", ["newIdempotencyKey"], []],
  ];
  if (rows.length !== expected.length) {
    return `the probe returned ${rows.length} variants where ${expected.length} were measured ` +
      "when this check was written; if the change was deliberate, update this table";
  }
  for (const [variant, state, raised, fields] of expected) {
    const got = rows.find((r) => r.variant === variant);
    if (!got) return `the probe no longer returns the variant "${variant}"`;
    if (got.state !== state) {
      return `variant "${variant}" came back state=${got.state}; expected ${state}`;
    }
    const actual = flags.filter((f) => got[f]);
    if (actual.join(",") !== [...raised].join(",")) {
      return `variant "${variant}" raised [${actual.join(", ") || "nothing"}]; expected ` +
        `[${raised.join(", ") || "nothing"}]`;
    }
    if ([...got.inventedFields].join(",") !== [...fields].join(",")) {
      return `variant "${variant}" named invented fields ` +
        `[${got.inventedFields.join(", ") || "none"}]; expected [${fields.join(", ") || "none"}]`;
    }
  }
  return null;
});
