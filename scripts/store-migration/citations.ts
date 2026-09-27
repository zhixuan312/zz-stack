/**
 * What a document's own bytes say about its citations, and the one reader that turns a frontmatter
 * field into a list.
 *
 * `doc_link` is built from two facts about a document: the paths it cites, and the documents a
 * source bears on. Neither is a column any more — `007_drop_legacy_store.sql` dropped `doc.evidence`
 * and `doc.supports` with the rest of the file store's index — and neither ever was a fact of its
 * own: `indexDoc` wrote `list(env.evidence || env.sources)` into the array and `env.supports` into
 * the string, both read off the document's own file. This module is that same reading, of the same
 * keys, from the same file, which is what makes the carry's links the ones the store already had.
 *
 * `envelopeList` is the list reader those two fields need, and it is exactly `indexDoc`'s own: one
 * frontmatter line, comma-separated, quotes stripped, empty parts dropped — the same treatment the
 * revision rows' `tags` get, so the two readings of an envelope field cannot drift apart.
 *
 * COUPLED: this is a leaf beside the entry point, and it holds the store's layout in one function —
 * a `_versions/<stem>.v<N>.md` frozen copy is a file of its own at the path its row carries, so the
 * same read answers for it and for a live document. `links.ts` decides what a link IS and this file
 * decides what the bytes say; neither re-implements the other's half.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseEnvelope } from "@zz/contracts";

import type { DocRow } from "./model.ts";

/** What a document's own bytes carry for `doc_link`. */
export interface Citations {
  /** The paths this document cites, inside its own initiative. */
  evidence: string[];
  /** The documents a source bears on, as the flow wrote them — list-read by the caller, because
   *  the real store writes more than one into the single frontmatter field. */
  supports: string | null;
}

/** A document's citations, or why the store could not be read for it. Local rather than exported:
 *  a caller reads the two branches of what `citationsAt` answers, and a name it does not import is
 *  a name this module would be claiming somebody else needs. */
type CitationsRead = { cites: Citations } | { refused: string };

/** `indexDoc`'s own list reader: one frontmatter line, comma-separated, quotes stripped. */
export function envelopeList(value: string | undefined): string[] {
  return (value ?? "").replace(/^\[|\]$/g, "").split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

/**
 * A document's citations, read back off the file the store holds it in.
 *
 * The path is the row's own — `<team>/<initiative>/<path>` — so a frozen copy is read from its own
 * file rather than from its parent's current revision, which is the file that row was indexed from.
 *
 * DELIBERATE: no file, or a file that cannot be read, is a refusal rather than an empty list. Read
 * as an empty list, a document the store has lost would arrive as a document that cites nothing —
 * a claim about the document where the truth is a claim about the store.
 */
export function citationsAt(teamDir: string, doc: DocRow): CitationsRead {
  const file = join(teamDir, doc.initiative, doc.path);
  if (!existsSync(file)) return { refused: "no such file in the store" };
  try {
    const env = parseEnvelope(readFileSync(file, "utf8"));
    return { cites: { evidence: envelopeList(env.evidence || env.sources), supports: env.supports ?? null } };
  } catch (err) {
    return { refused: err instanceof Error ? err.message : String(err) };
  }
}
