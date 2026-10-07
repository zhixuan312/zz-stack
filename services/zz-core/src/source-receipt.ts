/**
 * What `source_add` files beside a source and answers with: the revisions it cites, and the
 * receipt's lines.
 *
 * Out of `tools/artifacts.ts`, which registers `source_add`, so that file stays under the line
 * ceiling with the document tools in it; nothing here registers a tool or decides a write.
 */
import type pg from "pg";

import type { Line } from "./document-details.js";
import { documentAt } from "./versions.js";

/** What `source_add` answers with, line by line: the name it was filed under, and why when that
 *  was another; what it supports and how each entry was read, counted; the round it counts as;
 *  and the documents it could not link yet or that were approved before it arrived. */
export function sourceReceipt(o: {
  rel: string; asked: string; list: string[]; normalised: string[]; round: { stage: string; document: string } | null;
  auditsVersion: string | undefined; stage: string | undefined; review: boolean; unwritten: string[]; stale: string[];
  upload: Line[];
}): Line[] {
  const n = o.unwritten.length;
  return [
    `source recorded: ${o.rel}`,
    ...(o.rel !== o.asked ? [`source name: ${o.asked} was taken, so this was filed as ${o.rel}`] : []),
    ...o.upload,
    ...(o.list.length ? [{ label: "supports", items: o.list }] : []),
    { label: "normalised", items: o.normalised, sep: "; " },
    ...(o.round ? [`recorded as a ${o.round.stage} round on ${o.round.document}` + (o.auditsVersion ? ` v${o.auditsVersion}` : "")] : []),
    ...(o.stage && !o.round
      ? ["", `NOT COUNTED AS A ROUND: "${o.stage}" is not a stage of this flow that produces a source ` +
         `supporting ${o.list.join(", ") || "nothing"}, so this was recorded as material only.`] : []),
    ...(n ? ["", { lead: "NOT LINKED YET: ", label: "documents that do not exist yet", items: o.unwritten,
                   tail: ` — the link is filed when ${n > 1 ? "each is" : "it is"} first written, and until then this ` +
                     `source is not listed as material behind ${n > 1 ? "them" : "it"}.` +
                     (o.review ? " The review round itself is counted by its stage, not by the link." : "") }] : []),
    ...(o.stale.length
      ? ["", { lead: "Note for whoever works on this next: ", label: "documents approved before this material arrived",
               items: o.stale, tail: ", so the approval does not cover it. initiative_status reports this under " +
                 "sources_after_approval. Whether to change the document is the team's call — if they decide to, " +
                 "document_edit naming this source opens the next version and re-opens the gate." }]
      : o.list.length && !o.round ? ["", "No approved document is affected."] : []),
  ];
}

/** The current revision of each document a source names in `supports`, as `cites` links. A name
 *  that resolves to no document is skipped: a source may cite material outside this store, and
 *  a link to a row nobody has is a foreign key Postgres would refuse. */
export async function citedRevisions(
  p: Pick<pg.Pool, "query">, team: string, initiative: string, names: string[],
): Promise<{ path: string; revision: number }[]> {
  const out: { path: string; revision: number }[] = [];
  for (const d of names) {
    const path = `${initiative}/${d}`;
    const at = await documentAt(p, team, path);
    if (at && at.current_revision !== null) out.push({ path, revision: at.current_revision });
  }
  return out;
}
