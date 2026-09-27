/**
 * `doc_link` — the rows, and only the rows.
 *
 * The spec fixes two grains and they are not the same relation (FR-13). A document's `evidence` is
 * a list of paths inside its own initiative, and each becomes a `cites` link pinned to exact
 * revisions at BOTH ends: one revision of one document cites one revision of another. A source's
 * `supports` names the document it bears on, and becomes a `supports` link pinned to the source's
 * revision at one end and left null at the other, because a source supports the work across the
 * document's later revisions rather than one historical target revision.
 *
 * DELIBERATE: what each link is — which revision it starts from, which document and revision it
 * names — is decided before this module sees it, and the caller hands over a flat list. That
 * decision is the store's own reading plus the revision placement, which live where the store is
 * read; what is left here is a row, a count and the report line for a citation whose target the
 * index does not hold. A module that resolved paths as well would be a second reader of the store's
 * naming, and the two could disagree.
 */
import type { Queryable } from "./model.ts";
import type { StoreReport } from "./report.ts";

/** One citation, fully decided: the revision it starts at, and the document it names — or none,
 *  when the store's record names a path the index does not hold. */
export interface Link {
  /** `team/initiative/path`, as the report names the document the citation is written on. */
  where: string;
  fromId: string;
  fromRevision: number;
  /** The path as the store wrote it, quoted back when nothing resolves. */
  cited: string;
  kind: "cites" | "supports";
  /** `null` when the cited path names no document the index holds, or no revision of it. */
  to: { id: string; revision: number | null } | null;
}

/**
 * Every citation the store records becomes a row, and one whose target is not there becomes a
 * report line instead.
 *
 * `on conflict do nothing` on the spec's unique index over the five columns, so a second run of the
 * carry adds nothing rather than refusing: a duplicate is not an error here, it is a carry that has
 * already run.
 */
export async function writeLinks(
  db: Queryable, links: Link[], report: StoreReport,
): Promise<void> {
  for (const link of links) {
    if (!link.to) {
      const line = `${link.where}: ${link.kind === "cites" ? "cites" : "supports"} ${link.cited}`;
      if (link.kind === "cites") report.unresolvedLinks.cites.push(line);
      else report.unresolvedLinks.supports.push(line);
      continue;
    }
    await db.query(
      `insert into zz.doc_link (from_doc_id, from_revision, to_doc_id, to_revision, kind)
       values ($1,$2,$3,$4,$5) on conflict do nothing`,
      [link.fromId, link.fromRevision, link.to.id, link.to.revision, link.kind]);
    if (link.kind === "cites") report.links.cites++;
    else report.links.supports++;
  }
}
