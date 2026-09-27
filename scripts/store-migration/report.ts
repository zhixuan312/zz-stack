/**
 * What the carry did, and what it could not do — one line each.
 *
 * The report is the plan's `run:` evidence: documents read, revisions retained, revisions marked
 * `missing_legacy`, both legacy pin counts, the citations written and the refusals. It is a
 * separate subject from the carry that produces it, because a reader checking that the store was
 * carried whole reads this and not the code that wrote the rows.
 *
 * DELIBERATE: the lines are prefixed `store-migration:` and printed by whoever runs the carry —
 * `scripts/rehearse.ts` under its `withArtifacts` step, or the CLI. Nothing here writes to a
 * stream, so a caller that wants the report as data can have it.
 */

/* --------------------------------------------------------------------------------- the report */

export interface StoreReport {
  teams: string[];
  /** A directory under `teams/` that names no `zz.team` — nothing to write rows onto. */
  teamsNotCarried: string[];
  documentsRead: number;
  revisionsRetained: number;
  revisionsMissingLegacy: number;
  /** How the unavailable revisions are named, counted by the record that names them. */
  missingReasons: Record<string, number>;
  /** Documents whose frozen approval copy for their own current revision differs from the live
   *  file: `bytes` is the population, `bodyDiffers` the subset that is a loss rather than the
   *  close-time envelope stamp. */
  frozenCopies: { bytes: number; bodyDiffers: number };
  pins: {
    assessmentsPinned: number;
    assessmentsUnpinned: number;
    protocolsPinned: number;
    protocolsUnpinned: number;
    /** One line per pin left null, naming what the report could not resolve. */
    unpinned: string[];
  };
  links: { cites: number; supports: number };
  /** A citation that names a document the index does not hold. Not a refusal — the document it is
   *  written on was read and carried — but a gap in the store's own record, and a number here
   *  rather than a link silently left out. */
  unresolvedLinks: { cites: string[]; supports: string[] };
  /** The store's other records, verified against the rows they are already held in. A record the
   *  database does not have is a number here rather than an unobservable. */
  records: { checked: number; unmatched: string[] };
  journalNodes: { checked: number; unmatched: string[] };
  refusals: string[];
}

export function emptyReport(): StoreReport {
  return {
    teams: [], teamsNotCarried: [], documentsRead: 0, revisionsRetained: 0,
    revisionsMissingLegacy: 0, missingReasons: {}, frozenCopies: { bytes: 0, bodyDiffers: 0 },
    pins: { assessmentsPinned: 0, assessmentsUnpinned: 0, protocolsPinned: 0, protocolsUnpinned: 0, unpinned: [] },
    links: { cites: 0, supports: 0 }, unresolvedLinks: { cites: [], supports: [] },
    records: { checked: 0, unmatched: [] },
    journalNodes: { checked: 0, unmatched: [] }, refusals: [],
  };
}

/** The report, one line each — what the plan's `run:` clause asks the carry to state. */
export function formatReport(r: StoreReport): string[] {
  const reasons = Object.entries(r.missingReasons).map(([k, v]) => `${k} ${v}`).join(", ");
  const lines = [
    `store-migration: ${r.teams.length} team(s) read — ${r.teams.join(", ") || "none"}` +
      (r.teamsNotCarried.length ? ` (${r.teamsNotCarried.length} store(s) not carried: ${r.teamsNotCarried.join(", ")})` : ""),
    `store-migration: documents read ${r.documentsRead}`,
    `store-migration: revisions retained ${r.revisionsRetained}`,
    `store-migration: revisions marked missing_legacy ${r.revisionsMissingLegacy}` +
      (reasons ? ` (${reasons})` : ""),
    `store-migration: frozen approval copies differing from the live file ` +
      `${r.frozenCopies.bytes} (bodies identical ${r.frozenCopies.bytes - r.frozenCopies.bodyDiffers})`,
    `store-migration: pin eval_protocol_version.approved_doc_revision — ` +
      `${r.pins.protocolsPinned} pinned, ${r.pins.protocolsUnpinned} left null`,
    `store-migration: pin eval_assessment.doc_revision — ` +
      `${r.pins.assessmentsPinned} pinned, ${r.pins.assessmentsUnpinned} left null`,
    `store-migration: doc_link — ${r.links.cites} cites, ${r.links.supports} supports` +
      ` (${r.unresolvedLinks.cites.length} cite(s) and ${r.unresolvedLinks.supports.length} ` +
      "support(s) name a document the index does not hold)",
    `store-migration: records checked ${r.records.checked}, with no matching row ${r.records.unmatched.length}`,
    `store-migration: journal nodes checked ${r.journalNodes.checked}, with no matching row ` +
      `${r.journalNodes.unmatched.length}`,
  ];
  for (const reason of r.pins.unpinned) lines.push(`store-migration: pin left null — ${reason}`);
  for (const u of r.unresolvedLinks.cites) lines.push(`store-migration: citation with no target — ${u}`);
  for (const u of r.unresolvedLinks.supports) lines.push(`store-migration: support with no target — ${u}`);
  for (const u of r.records.unmatched) lines.push(`store-migration: record with no row — ${u}`);
  for (const u of r.journalNodes.unmatched) lines.push(`store-migration: journal node with no row — ${u}`);
  lines.push(`store-migration: refusals ${r.refusals.length}`);
  for (const refusal of r.refusals) lines.push(`store-migration: REFUSED — ${refusal}`);
  return lines;
}
