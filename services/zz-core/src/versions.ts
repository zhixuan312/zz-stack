/**
 * A document's frozen history: the copies filed under `_versions/`, and the document stated
 * to a person alongside them.
 *
 * WRITING A SNAPSHOT IS `persist.ts`'s — snapshotOnApproval copies the approved content to
 * `<initiative>/_versions/<doc>.v<N>.md` the moment status flips. READING ONE IS THIS
 * MODULE'S, and until now nothing owned that half: the directory was readable, unlistable,
 * and its path form appeared nowhere a caller could find.
 *
 * `presentDocument` lives here rather than in `tools/artifacts.ts` because everything it adds
 * over a plain read is in this subject — the version list it states, and the `shown` row it
 * records per document. Everything here takes `root` explicitly and touches no request, so
 * the check that guards it drives the real functions over a fixture directory.
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

/** THE HISTORY, MADE DISCOVERABLE, and still unwritable.
 *
 * `_versions/` has always been readable and has never been findable. `writeGuard` refuses
 * every write to it — that refusal is the whole reason an approval means the bytes it signed
 * — and nothing refuses a read, but no tool listed the directory.
 * Readable and unwritable is the pair that was wanted;
 * unwritable and undiscoverable was an accident of the guard. The `.v<N>.md` path form
 * appeared nowhere a caller could reach it either.
 *
 * THE APPROVAL FACTS COME OFF EACH SNAPSHOT'S OWN ENVELOPE, never off the live document. A
 * snapshot is written at the instant status flips to approved, so it carries who signed THAT
 * version and when; reading them from the current file would stamp today's signature on every
 * historical copy and make a version list that is the same row repeated.
 *
 * Pure and `root`-relative on purpose — no `safePath`, no `userRoot`, no request — so the
 * check that guards it drives it over a fixture directory rather than over a live store.
 * Nothing here refuses; what a missing version means is the caller's decision. */
export function documentVersions(root: string, relPath: string): DocumentVersion[] {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2) return [];
  const dir = join(root, parts[0], "_versions");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  // ANCHORED ON THE WHOLE STEM. `spec.md` and `spec-review.md` share a prefix, so a
  // `startsWith` files one document's approvals under its neighbour's history — and a version
  // list that shows somebody else's signatures is worse than no version list.
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

/** A `version` that does not exist is refused — and the refusal NAMES THE ONES THAT DO.
 *
 * "no such version" sends a caller guessing at numbers against a directory they cannot list.
 * The numbers are already in hand here, so listing them answers the question they were about
 * to ask next. Returns null when the version is there. */
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

/** ONE DOCUMENT PRESENTED, AND ONE `shown` ROW FOR IT.
 *
 * The per-document half of `document_present`, lifted out of the registration so that "one
 * row per document" is a property a check can RUN rather than one it reads. A present over an
 * array calls this once per path; a single row covering a batch would let `attest.ts`
 * shownSinceLastChange answer "fetched" for a document whose neighbour was the one opened,
 * and that answer is what an approval leans on.
 *
 * THE ROW NAMES THE BYTES THAT WERE ACTUALLY RETURNED. Fetching v1 records a `shown` on
 * `<initiative>/_versions/<doc>.v1.md`, not on the current path — shownSinceLastChange matches
 * on path and ignores version by design, so recording a historical fetch against the live path
 * would make "someone opened v1" read as attestation of the v3 nobody looked at. The contract
 * is silent on this; opening history must not vouch for the present.
 *
 * On success only: a refusal fetched nothing and has no bytes to have shown. And the record
 * cannot cost the document — logActivity swallows its own errors, "telemetry must never break
 * the operation it describes", so an unwritable activity.jsonl costs the row and never the
 * fetch. */
export function presentDocument(
  root: string, relPath: string, version: number | undefined, user: string,
): string {
  const rows = documentVersions(root, relPath);
  let readRel = relPath;
  if (version !== undefined) {
    // ONE LOOKUP, AND ITS FAILURE IS A REFUSAL RATHER THAN A FALLBACK. Written as
    // `rows.find(...)?.rel ?? relPath`, the clause that satisfies the compiler is also the bug
    // this function's header rules out: it would present the CURRENT document while the caller
    // asked for version N, and record `shown` against the live path. There is no reading of a
    // missing version that is safer than saying so.
    const hit = rows.find((v) => v.version === version);
    if (!hit) {
      return versionRefusal(root, relPath, version)
        ?? `ERROR: \`${relPath}\` has no version ${version}.`;
    }
    readRel = hit.rel;
  }
  const content = readFileSync(join(root, readRel), "utf8");
  const env = parseEnvelope(content);
  // ONLY WHAT THE DOCUMENT CARRIES. A source has no version and no status, and stating
  // "version: none" for one is the platform asserting a lifecycle nothing governs — the same
  // line stampEnvelope declines to cross for a document no manifest declares.
  const facts = [`This is ${readRel}`];
  if (env.version) facts.push(`version ${env.version}`);
  if (env.status) facts.push(`status ${env.status}`);
  const signed = env.approved_by
    ? ` Approved by ${env.approved_by}${env.approved_at ? ` on ${env.approved_at}` : ""}.`
    : "";
  logActivity(root, readRel, { user, action: "shown", path: readRel, version: env.version ?? "" });
  return `${facts.join(", ")}.${signed}\n${versionHistory(rows)}\n\n${documentBody(content).trim()}\n`;
}

