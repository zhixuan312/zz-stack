/**
 * A document's frozen history: the copies filed under `_versions/`, and the document stated
 * to a person alongside them.
 *
 * COUPLED: writing a snapshot is `persist.ts`'s — snapshotOnApproval copies the approved
 * content to `<initiative>/_versions/<doc>.v<N>.md` the moment status flips. Reading one is
 * this module's.
 *
 * `presentDocument` lives here rather than in `tools/artifacts.ts` because everything it adds
 * over a plain read is in this subject — the version list it states, and the `shown` row it
 * records per document. Everything here takes `root` explicitly and touches no request, so the
 * check that guards it drives the real functions over a fixture directory.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { documentBody, parseEnvelope } from "@zz/contracts";

import { logActivity } from "./persist.js";

/** One frozen copy of a document — `<initiative>/_versions/<doc>.v<N>.md`, the name
 * `persist.ts` snapshotOnApproval writes — with the approval that copy carries. */
type DocumentVersion = {
  version: number;
  rel: string;
  status: string;
  approved_by: string;
  approved_at: string;
};

/** The history, listed. `_versions/` is readable and `writeGuard` refuses every write to it,
 * which is what makes an approval mean the bytes it signed.
 *
 * The approval facts come off each snapshot's own envelope, never off the live document: a
 * snapshot carries who signed that version and when, and reading them from the current file
 * would make a version list that is the same row repeated.
 *
 * Pure and `root`-relative — no `safePath`, no `userRoot`, no request — so the check that
 * guards it drives it over a fixture directory. Nothing here refuses; what a missing version
 * means is the caller's decision. */
export function documentVersions(root: string, relPath: string): DocumentVersion[] {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2) return [];
  const dir = join(root, parts[0], "_versions");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  // Anchored on the whole stem: `spec.md` and `spec-review.md` share a prefix, so a
  // `startsWith` would file one document's approvals under its neighbour's history.
  const stem = parts[1].replace(/\.md$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const shape = new RegExp(`^${stem}\\.v(\\d+)\\.md$`);
  const rows: DocumentVersion[] = [];
  for (const f of readdirSync(dir)) {
    const m = shape.exec(f);
    if (!m) continue;
    const env = parseEnvelope(readFileSync(join(dir, f), "utf8"));
    rows.push({
      version: Number(m[1]),
      rel: `${parts[0]}/_versions/${f}`,
      status: env.status ?? "",
      approved_by: env.approved_by ?? "",
      approved_at: env.approved_at ?? "",
    });
  }
  // Numerically, not by filename: readdirSync sorts v10 before v2 and a history out of order
  // reads as a history with gaps.
  return rows.sort((a, b) => a.version - b.version);
}

/** A `version` that does not exist is refused, and the refusal names the ones that do: "no
 * such version" alone sends a caller guessing at numbers against a directory they cannot list.
 * Returns null when the version is there. */
export function versionRefusal(root: string, relPath: string, version: number): string | null {
  const rows = documentVersions(root, relPath);
  if (rows.some((v) => v.version === version)) return null;
  return rows.length
    ? `ERROR: \`${relPath}\` has no version ${version}. Filed: ` +
      `${rows.map((v) => `v${v.version}`).join(", ")} — ask for one of those, or omit ` +
      "`version` for the current document."
    : `ERROR: \`${relPath}\` has no version ${version} — no version of it is filed at all. ` +
      "A copy lands in `_versions/` each time an approval does, so a document that has never " +
      "been approved has none. Omit `version` for the current document.";
}

/** The version list stated beside the document: what each version was approved as, and when. */
function versionHistory(rows: DocumentVersion[]): string {
  if (!rows.length) return "Versions filed: none — no approval has landed on this document yet.";
  const each = rows.map((v) =>
    `v${v.version} ${v.status || "filed"}` +
    (v.approved_by ? ` by ${v.approved_by}` : "") +
    (v.approved_at ? ` on ${v.approved_at}` : ""));
  return `Versions filed: ${each.join("; ")}. Read one with \`version: N\`.`;
}

/** One document presented, and one `shown` row for it.
 *
 * The per-document half of `document_present`, lifted out of the registration so that "one row
 * per document" is a property a check can run. A present over an array calls this once per
 * path; a single row covering a batch would let `attest.ts` shownSinceLastChange answer
 * "fetched" for a document whose neighbour was the one opened.
 *
 * The row names the bytes that were returned: fetching v1 records a `shown` on
 * `<initiative>/_versions/<doc>.v1.md`, not on the current path. shownSinceLastChange matches
 * on path and ignores version, so recording a historical fetch against the live path would
 * make "someone opened v1" read as attestation of the v3 nobody looked at.
 *
 * On success only: a refusal fetched nothing. logActivity swallows its own errors, so an
 * unwritable activity.jsonl costs the row and never the fetch. */
export function presentDocument(
  root: string, relPath: string, version: number | undefined, user: string,
): string {
  const rows = documentVersions(root, relPath);
  let readRel = relPath;
  if (version !== undefined) {
    // A missing version is a refusal, never a fallback: `rows.find(...)?.rel ?? relPath` would
    // present the current document while the caller asked for version N, and record `shown`
    // against the live path.
    const hit = rows.find((v) => v.version === version);
    if (!hit) {
      return versionRefusal(root, relPath, version)
        ?? `ERROR: \`${relPath}\` has no version ${version}.`;
    }
    readRel = hit.rel;
  }
  const content = readFileSync(join(root, readRel), "utf8");
  const env = parseEnvelope(content);
  // Only what the document carries: a source has no version and no status, and stating
  // "version: none" for one asserts a lifecycle nothing governs.
  const facts = [`This is ${readRel}`];
  if (env.version) facts.push(`version ${env.version}`);
  if (env.status) facts.push(`status ${env.status}`);
  const signed = env.approved_by
    ? ` Approved by ${env.approved_by}${env.approved_at ? ` on ${env.approved_at}` : ""}.`
    : "";
  logActivity(root, readRel, { user, action: "shown", path: readRel, version: env.version ?? "" });
  return `${facts.join(", ")}.${signed}\n${versionHistory(rows)}\n\n${documentBody(content).trim()}\n`;
}

