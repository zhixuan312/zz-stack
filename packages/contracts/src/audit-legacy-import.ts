/**
 * The six historical audit rounds, imported with what is missing still missing: three against
 * one document and three against another.
 *
 * DELIBERATE: `reviewer_identity` is the unavailable sentinel on every row, although
 * `contributed_by` is present and identical on all six. That field names the account that
 * filed the material with the platform, not who read the document and formed the findings, so
 * promoting it would turn six reports with unknown reviewers into six apparently reviewed by
 * one person. {@link LegacyAuditRow.provenance} says so in the row itself.
 *
 * DELIBERATE: no digest is written by default, because none of these rows has one. A hash
 * computed today over bytes read today is evidence about today's bytes, not a historical
 * signature. A caller with the bytes can pass them in; the digest is then computed here,
 * labelled `computed_at_import`, and stamped with the moment it was observed and the byte
 * count it covered.
 *
 * DELIBERATE: H-S2 and H-P3 carry a null `supports`, preserved rather than filled from the
 * round's subject. `supports` is what the platform reads to decide which document's next
 * revision must cite this round, so a value nobody wrote is a link nobody made. The round's
 * target is a separate field and is not empty: each report names its subject in its title.
 *
 * Nothing here is derived from another field. Every value is transcribed from the spec's
 * historical mapping table, and the per-field provenance map names the source for each one.
 */
import { createHash } from "node:crypto";

import { UNAVAILABLE, type AuditIdentity } from "./audit-identity.js";

/** What the audited state was grounded against, where the report said so. `none` is a real
 *  answer two of the six gave, and is not the same as a grounding nobody recorded. */
export type RepositoryGrounding =
  | { readonly kind: "commit"; readonly value: string }
  | { readonly kind: "migration_head"; readonly value: string }
  | { readonly kind: "none" };

/** Where one field's value came from. Carried per field rather than per row because the row is
 *  a mixture: a title is a record, an empty envelope field is an absence, and a sentinel is a
 *  decision this import made. */
export type FieldOrigin =
  | "spec_historical_mapping_table"
  | "declared_in_report_title"
  | "declared_in_source_envelope"
  | "empty_in_source_envelope"
  | "not_recorded_by_any_report"
  | "computed_at_import";

/** One imported round. The six identities are the first six fields, inherited from
 *  {@link AuditIdentity}. */
export interface LegacyAuditRow extends AuditIdentity {
  readonly id: string;
  /** The document whose next revision had to cite this round — null where nobody wrote one. */
  readonly supports: string | null;
  /** The version of the target the report names as what it read. */
  readonly approval_version: number | null;
  readonly snapshot_sha256: string | null;
  readonly hash_origin: "computed_at_import" | "unavailable";
  readonly hash_observed_at: string | null;
  readonly hashed_byte_count: number | null;
  readonly repository_grounding: RepositoryGrounding;
  readonly added_at: string;
  readonly provenance: Readonly<Record<string, FieldOrigin>>;
}

/** The transcription, one entry per row of the spec's table. Held separately from the row
 *  builder, so what was copied from the record and what this module decided are two different
 *  pieces of text. */
interface LegacySeed {
  readonly id: string;
  readonly report_ref: string;
  readonly target: string;
  readonly approval_version: number;
  readonly round: number;
  readonly added_at: string;
  readonly supports: string | null;
  readonly repository_grounding: RepositoryGrounding;
}

const SPEC_DOC = "spec.md";
const PLAN_DOC = "plan.md";

/** Base initiative for all six: 2026-09-19-how-sources-and-knowledge-are-stored-and-retrieved,
 *  under its sources/ folder. The refs below are the filenames within it. */
const SEEDS: readonly LegacySeed[] = Object.freeze([
  {
    id: "H-S1",
    report_ref: "2026-09-20-sdlc-spec-audit-round-1-deliverable-contract-gaps-d-table-ra.md",
    target: SPEC_DOC, approval_version: 4, round: 1,
    added_at: "2026-09-19T23:23:34.193Z",
    supports: SPEC_DOC,
    repository_grounding: { kind: "none" },
  },
  {
    id: "H-S2",
    report_ref: "2026-09-20-sdlc-spec-audit-round-2-migration-numbering-self-contradicti.md",
    target: SPEC_DOC, approval_version: 5, round: 2,
    added_at: "2026-09-19T23:42:56.977Z",
    supports: null,
    repository_grounding: { kind: "migration_head", value: "068_two_axes_and_no_verdict.sql" },
  },
  {
    id: "H-S3",
    report_ref: "2026-09-20-sdlc-spec-audit-round-3-semantic-field-list-contradiction-re.md",
    target: SPEC_DOC, approval_version: 6, round: 3,
    added_at: "2026-09-19T23:54:03.451Z",
    supports: SPEC_DOC,
    repository_grounding: { kind: "none" },
  },
  {
    id: "H-P1",
    report_ref: "2026-09-20-sdlc-plan-audit-round-1-gate-self-recursion-seven-suites-nev.md",
    target: PLAN_DOC, approval_version: 1, round: 1,
    added_at: "2026-09-20T01:15:06.414Z",
    supports: PLAN_DOC,
    repository_grounding: { kind: "commit", value: "ea02ad0" },
  },
  {
    id: "H-P2",
    report_ref: "2026-09-20-sdlc-plan-audit-round-2-i-19-forward-dependency-breaks-seque.md",
    target: PLAN_DOC, approval_version: 2, round: 2,
    added_at: "2026-09-20T01:29:39.413Z",
    supports: PLAN_DOC,
    repository_grounding: { kind: "commit", value: "ea02ad0" },
  },
  {
    id: "H-P3",
    report_ref: "2026-09-20-sdlc-plan-audit-round-3-corpus-check-still-can-t-prove-full.md",
    target: PLAN_DOC, approval_version: 3, round: 3,
    added_at: "2026-09-20T01:41:05.561Z",
    supports: null,
    repository_grounding: { kind: "commit", value: "ea02ad0" },
  },
]);

/** The bytes of one report, as a caller read them. Keyed by `report_ref`, so a caller that
 *  retrieved four of the six gets four computed digests and two absences rather than an
 *  all-or-nothing import. */
export type LegacySnapshotBytes = ReadonlyMap<string, string>;

/** What each identity field's value is grounded in.
 *
 *  DELIBERATE: `execution_id` and `attempt_id` are unavailable. These rounds predate run
 *  identity, so there is no execution to name; the round ordinal is recorded in each report's
 *  title, but an ordinal is not an attempt id inside an execution that never existed. The
 *  round survives as `approval_version` plus the ordinal in the ref. */
function provenanceOf(row: LegacySeed): Readonly<Record<string, FieldOrigin>> {
  return Object.freeze({
    execution_id: "not_recorded_by_any_report" as const,
    attempt_id: "not_recorded_by_any_report" as const,
    reviewer_identity: "not_recorded_by_any_report" as const,
    target: "declared_in_report_title" as const,
    report_ref: "spec_historical_mapping_table" as const,
    completion: "declared_in_source_envelope" as const,
    supports: (row.supports === null
      ? "empty_in_source_envelope"
      : "declared_in_source_envelope") as FieldOrigin,
    approval_version: "declared_in_report_title" as const,
    added_at: "declared_in_source_envelope" as const,
    repository_grounding: "spec_historical_mapping_table" as const,
  });
}

/**
 * Imports the six, with or without the bytes.
 *
 * Called with nothing, every row comes back with a null digest and `unavailable` as its
 * origin. Called with bytes, the digest is computed here and labelled `computed_at_import`
 * alongside the instant it was observed and the number of bytes it covered — all three
 * together, because a digest with no observation time is indistinguishable from one that has
 * always been there.
 *
 * `completion` is the one identity these reports supply themselves: each carries substantive
 * findings and a conclusion-and-coverage record, so the round is recorded as having concluded
 * with findings. That describes the report's structure, not whether what it found was fixed.
 */
export function importLegacyAudits(snapshots?: LegacySnapshotBytes): readonly LegacyAuditRow[] {
  const observedAt = new Date().toISOString();
  return Object.freeze(SEEDS.map((seed) => {
    const bytes = snapshots?.get(seed.report_ref);
    const hashed = bytes === undefined
      ? null
      : {
          digest: createHash("sha256").update(bytes, "utf8").digest("hex"),
          byteCount: Buffer.byteLength(bytes, "utf8"),
        };
    const provenance = hashed === null
      ? provenanceOf(seed)
      : Object.freeze({ ...provenanceOf(seed), snapshot_sha256: "computed_at_import" as const });
    return Object.freeze({
      execution_id: UNAVAILABLE,
      attempt_id: UNAVAILABLE,
      reviewer_identity: UNAVAILABLE,
      target: seed.target,
      report_ref: seed.report_ref,
      completion: "concluded_with_findings",
      id: seed.id,
      supports: seed.supports,
      approval_version: seed.approval_version,
      snapshot_sha256: hashed?.digest ?? null,
      hash_origin: (hashed === null ? "unavailable" : "computed_at_import") as
        "computed_at_import" | "unavailable",
      hash_observed_at: hashed === null ? null : observedAt,
      hashed_byte_count: hashed?.byteCount ?? null,
      repository_grounding: seed.repository_grounding,
      added_at: seed.added_at,
      provenance,
    });
  }));
}
