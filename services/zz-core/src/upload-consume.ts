/**
 * Consumption: a staged upload becomes the text a write stores, inside that write.
 *
 * `upload_start` mints a `zz.upload` row and the gateway binds a file's bytes to it once
 * (services/gateway/src/upload.ts). A write that names the upload — `document_write`, `document_edit`
 * or `source_add` with `upload` — takes it in this order, the first that applies answering:
 *
 *   (1) the request key, looked up by the tool before anything here runs (`replayFor`), so a keyed
 *       write that already committed replays its receipt after the upload was used or expired;
 *   (2) the row read and checked — the caller's own upload, in the team they act for (`FORBIDDEN`),
 *       staged (`UPLOAD_MISSING`), unexpired (`UPLOAD_EXPIRED`) and unconsumed (`UPLOAD_USED`) —
 *       before its body is read (`stagedUpload`);
 *   (3) the body decoded by the same `uploadText` the staging route refused by, then planned and
 *       guarded as typed content (`uploadContent` for a document; a source keeps it literally);
 *   (4) inside `saveDocument`'s transaction, under the document's lock, the row locked and checked
 *       again, marked consumed with the operation and the call's digest, and its body removed, in
 *       the write's own commit (`consumeUpload`). A refusal or a fault anywhere before that commit
 *       rolls it back, so the upload stays unconsumed until it expires.
 *
 * A ChatGPT `file` (`fileSource`) takes the same path from (3) on: its bytes are fetched by the
 * guarded helper (file-fetch.ts) before the write's transaction, decoded by the same `uploadText`,
 * and planned as an upload is. It has no row, so there is nothing to lock or consume at (4); its
 * request key binds the `file_id` and the digest of what was fetched (document-change.ts).
 *
 * DELIBERATE: two entry points, not one. `uploadContent` reads a Markdown file through
 * `normalizeContent` and asks `bodyEnvelopeRefusal` of any other, and a refusal reached through it
 * tells the caller to send `title`, `tags`, `stakeholder` and `fields` — arguments `source_add` does
 * not have (scripts/gate/checks/documents-guards.ts). A source keeps its upload literally under the
 * platform's own envelope and never calls it.
 */
import { createHash } from "node:crypto";

import { UPLOAD_ID, uploadText } from "@zz/contracts";
import type pg from "pg";
import { z } from "zod";

import type { Line } from "./document-details.js";
import { bodyEnvelopeRefusal, type Metadata, normalizeContent } from "./document-normalize.js";
import { type FetchRoute, fetchFile } from "./file-fetch.js";
import { principalId } from "./versions.js";

/** An upload checked and decoded, or a ChatGPT file fetched and decoded: what a write plans with
 *  and what its receipt names. `id` is the upload's id, or the file's `file_id`. */
export interface Staged {
  via: "upload" | "file";
  id: string; filename: string; sha256: string; bytes: number;
  stagedVia: string; stagedBy: string | null;
  text: string; bom: boolean;
}

/** What `saveDocument` consumes under its lock: the upload, the digest planned from it, the tool
 *  that consumes it and the digest of the call that does. */
export interface Consumption { id: string; sha256: string; tool: string; digest: string }

/** The extensions a document reads as Markdown — through `normalizeContent`, like typed content. */
const MARKDOWN = /\.(md|markdown)$/i;

const forbidden = (id: string): string =>
  `ERROR: FORBIDDEN — ${JSON.stringify(id)} is not an upload of yours in the team you are acting for; ` +
  "call upload_start, stage the file it answers for, and send that upload.";
const expired = (id: string): string =>
  `ERROR: UPLOAD_EXPIRED — ${id}'s 15 minutes are over; call upload_start again, stage the file to the ` +
  "upload it answers with, and send that one.";
const used = (id: string): string =>
  `ERROR: UPLOAD_USED — ${id} was consumed by an earlier write, and an upload is used once; call ` +
  "upload_start again to send the same file to another write.";

/** Exactly one of `content`, `upload` and `file`, or the INVALID_MODE that says so. */
export function oneBody(a: { content?: string; upload?: string; file?: OpenAIFile }): string | null {
  if ([a.content, a.upload, a.file].filter((x) => x !== undefined).length === 1) return null;
  return "ERROR: INVALID_MODE — send the body ONE way: `content` (the words), `upload` (the id " +
    "upload_start answered, once its file is staged) or `file` (a file ChatGPT attached) — one, not two, and not none.";
}

/** (2) and (3): the caller's own staged, unexpired, unconsumed upload, decoded — or the refusal that
 *  stops the write. An id that names no upload is FORBIDDEN, as a foreign one is, so an id says
 *  nothing about whether it exists. */
export async function stagedUpload(
  p: Pick<pg.Pool, "query">, team: string, who: string, id: string,
): Promise<Staged | { refusal: string }> {
  if (!UPLOAD_ID.test(id)) return { refusal: forbidden(id) };
  const principal = await principalId(p, who);
  const { rows } = await p.query<{
    filename: string; sha256: string | null; byte_count: number | null; staged_via: string | null;
    staged_by: string | null; expired: boolean; consumed: boolean; mine: boolean;
  }>(
    `select u.filename, u.sha256, u.byte_count, u.staged_via, s.email as staged_by,
            u.expires_at <= now() as expired, u.consumed_at is not null as consumed,
            (u.principal_id = $2::uuid and u.team_id = t.id) as mine
       from zz.upload u
       left join zz.team t on t.slug = $3
       left join zz.principal s on s.id = u.staged_by
      where u.id = $1`, [id, principal, team]);
  const r = rows[0];
  if (!principal || !r?.mine) return { refusal: forbidden(id) };
  if (r.sha256 === null) {
    return { refusal: `ERROR: UPLOAD_MISSING — ${id} holds no file yet: run the \`shell\` upload_start answered ` +
      "with, or have the person open its `link`, then send this call again." };
  }
  if (r.expired) return { refusal: expired(id) };
  if (r.consumed) return { refusal: used(id) };
  // Read only now, once the row says it is this caller's to use.
  const held = (await p.query<{ body: Buffer | null; consumed: boolean }>(
    "select body, consumed_at is not null as consumed from zz.upload where id = $1", [id])).rows[0];
  if (!held?.body) return { refusal: held?.consumed ? used(id) : expired(id) };
  const read = uploadText(r.filename, held.body);
  if ("code" in read) return { refusal: read.refusal };
  return { via: "upload", id, filename: r.filename, sha256: r.sha256, bytes: r.byte_count ?? held.body.length,
           stagedVia: r.staged_via ?? "", stagedBy: r.staged_by, text: read.text, bom: read.bom };
}

/** (3) for a document: a Markdown file read as typed content is — its envelope separated and
 *  reported — and any other file stored literally, with the metadata the call names. A literal body
 *  that opens with what reads as an envelope is refused: stored, it would read back as the
 *  document's own envelope and refuse every later edit. */
export function uploadContent(s: Staged, named: Metadata): ReturnType<typeof normalizeContent> {
  if (MARKDOWN.test(s.filename)) return normalizeContent(s.text, named);
  if (bodyEnvelopeRefusal(s.text)) {
    return { refusals: [`ERROR: UNSUPPORTED_METADATA — ${JSON.stringify(s.filename)} opens with what reads as ` +
      "a frontmatter envelope (`---`, `key: value` lines, `---`), which a document's body cannot: it would " +
      "read back as the document's own. Add it as a source instead — source_add with this `upload` keeps " +
      "it as it is — or start the file with another line and stage it again."] };
  }
  const metadata = normalizeContent("", named);
  return "refusals" in metadata ? metadata : { ...metadata, body: s.text };
}

/** The receipt's lines for a consumed upload: which file, its digest, and how it was staged. */
export function uploadLines(s: Staged): Line[] {
  const blank = (/^(?:[ \t]*\r?\n)+/.exec(s.text)?.[0].match(/\n/g) ?? []).length;
  return [
    `${s.via}: ${s.id} — ${JSON.stringify(s.filename)}, ${s.bytes} bytes, sha256 ${s.sha256}, ` +
      `staged via ${s.stagedVia}${s.stagedBy ? ` by ${s.stagedBy}` : ""}`,
    ...(s.bom ? [`removed the byte-order mark ${JSON.stringify(s.filename)} opened with`] : []),
    // A stored body cannot begin with a blank line: the separator under the envelope is removed
    // whatever its count (documentBody), so the lines a file opened with go too, and are said.
    ...(blank ? [`removed the ${blank} blank line${blank === 1 ? "" : "s"} ${JSON.stringify(s.filename)} opened with`] : []),
  ];
}

/** (4): the upload, locked and checked again on the write's own client — the digest it was planned
 *  from, still unconsumed, still unexpired — then marked consumed by `<tool> <path>` with the call's
 *  digest, its body removed. Null when it was consumed; otherwise the refusal that rolls the write
 *  back. A concurrent consumer of the same upload waits on the row and then finds it used. */
export async function consumeUpload(c: Pick<pg.Pool, "query">, u: Consumption, relPath: string): Promise<string | null> {
  const { rows } = await c.query<{ sha256: string | null; consumed: boolean; expired: boolean }>(
    `select sha256, consumed_at is not null as consumed, expires_at <= now() as expired
       from zz.upload where id = $1 for update`, [u.id]);
  const r = rows[0];
  if (!r || r.sha256 !== u.sha256) return forbidden(u.id);
  if (r.consumed) return used(u.id);
  if (r.expired) return expired(u.id);
  await c.query(
    `update zz.upload set consumed_at = now(), consumed_by_operation = $2, consumed_digest = $3, body = null
      where id = $1`, [u.id, `${u.tool} ${relPath}`, u.digest]);
  return null;
}

/** A file ChatGPT attached to a call, as the Apps SDK hands it over (`openai/fileParams`). */
export interface OpenAIFile { download_url: string; file_id: string; mime_type?: string; file_name?: string }

/** `file` on the three write tools, each declaring it `.optional()` where it is used — the gate reads
 *  that at the field (scripts/gate/checks/skill-calls.ts). */
export const FILE_INPUT = z.object({
  download_url: z.string(), file_id: z.string(), mime_type: z.string().optional(), file_name: z.string().optional(),
}).describe("In place of `content`: a file attached in ChatGPT, which fills this in itself.");

/** The `_meta` that tells ChatGPT `file` takes an attached file. */
export const FILE_META = { "openai/fileParams": ["file"] };

/** What reads a ChatGPT `file` into a `Staged`, or answers the refusal that stops the write. */
export type FileSource = (file: OpenAIFile) => Promise<Staged | { refusal: string }>;

/** The `file` route over `options` — built once, by the tools, with `hosts` from
 *  `OPENAI_FILE_HOSTS` and nothing else; checks/file-fetch.ts passes the rest (file-fetch.ts).
 *  With no hosts the route is off and says so. With hosts, the file's name decides its format
 *  before anything is fetched — `file_name`, or the URL's last path segment — and the bytes go
 *  through `uploadText`, so a file is held to every rule an upload is. */
export function fileSource(options: FetchRoute = { hosts: [] }): FileSource {
  return async (file) => {
    if (!options.hosts.length) {
      return { refusal: "ERROR: FORBIDDEN — the ChatGPT file route is not enabled on this deployment " +
        "(OPENAI_FILE_HOSTS is empty), so `file` is not fetched; call upload_start with the file's name, stage the " +
        "file through the link it answers with, and send that `upload` in place of `file`." };
    }
    let name = file.file_name ?? "";
    if (!name) {
      try { name = decodeURIComponent(new URL(file.download_url).pathname.split("/").pop() ?? ""); } catch { name = ""; }
    }
    const format = uploadText(name, new Uint8Array(0));
    if ("code" in format) return { refusal: format.refusal };
    const got = await fetchFile(file.download_url, options);
    if ("refusal" in got) return got;
    const read = uploadText(name, got.bytes);
    if ("code" in read) return { refusal: read.refusal };
    return { via: "file", id: file.file_id, filename: name, sha256: createHash("sha256").update(got.bytes).digest("hex"),
             bytes: got.bytes.length, stagedVia: "file", stagedBy: null, text: read.text, bom: read.bom };
  };
}
