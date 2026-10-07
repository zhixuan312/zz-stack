/**
 * What an uploaded file may be, and the names an upload goes by — shared by every route a file
 * arrives through: the gateway's staging routes, and zz-core's consumption and its ChatGPT `file`
 * route. One family and one decoder, so a file one route takes is a file every route takes.
 *
 * The family is plain text and nothing else (FR-16). There is no extraction: a file is stored as
 * the text it is, with exactly one change — a leading byte-order mark is removed, and the caller is
 * told so. Trailing whitespace, line endings, tabs and markup are the author's and stay.
 *
 * The id an upload is known by appears in transcripts and tool arguments; the link secret is a
 * separate capability that authorises staging that one upload and nothing else, and only its
 * sha256 is stored (`zz.upload.link_secret_hash`), as every bearer secret here is.
 */
import { createHash, randomBytes } from "node:crypto";

/** FR-16's extensions, lowercase, without the dot. `.env` is not one: an environment file is a
 *  credential store far more often than material for a document. */
export const UPLOAD_EXTENSIONS = [
  "md", "markdown", "txt", "text", "csv", "tsv", "json", "yaml", "yml", "toml", "xml", "sql",
  "log", "ini", "conf", "rst", "adoc",
] as const;

/** The most one upload may carry, in bytes as sent — the stored-body limit's own figure, so no
 *  file that fits here is refused for its size once it is text. */
export const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

/** An upload's id: `up_` and 26 lowercase base32 characters of 128 random bits. */
export const UPLOAD_ID = /^up_[a-z2-7]{26}$/;
/** A staging link's secret: `us_` and 52 lowercase base32 characters of 256 random bits. */
export const UPLOAD_SECRET = /^us_[a-z2-7]{52}$/;

export type UploadRefusal = { code: "UNSUPPORTED_FORMAT" | "SIZE_LIMIT" | "INVALID_ENCODING"; refusal: string };
/** The file's text, and whether a leading BOM was removed to get it. */
export type UploadedText = { text: string; bom: boolean };

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, unpadded, the final partial group included. */
function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out;
}

export const mintUploadId = (): string => `up_${base32(randomBytes(16))}`;
export const mintUploadSecret = (): string => `us_${base32(randomBytes(32))}`;
/** What `zz.upload.link_secret_hash` holds for a secret: the sha256 hex of its UTF-8. */
export const uploadSecretHash = (secret: string): string => createHash("sha256").update(secret, "utf8").digest("hex");

const BOM = [0xef, 0xbb, 0xbf];
const FAMILY = UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(", ");

/** A file's bytes as the text a document or source stores, or the refusal that says what to send.
 *
 *  The extension is the one after the name's last dot, compared without case; a name with nothing
 *  before that dot (`.env`, `.md`) has no extension. The size is checked on the bytes as sent,
 *  before anything is decoded.
 *
 *  DELIBERATE: the decoder is told to keep the BOM (`ignoreBOM: true`) and this removes it itself.
 *  TextDecoder's default drops a leading BOM silently, and the spec allows that removal only with
 *  disclosure — which needs to know it happened.
 *
 *  DELIBERATE: a NUL is refused rather than kept or stripped. It is valid UTF-8, but PostgreSQL
 *  text cannot hold one, so keeping it fails the write and stripping it changes the text. */
export function uploadText(filename: string, bytes: Uint8Array): UploadedText | UploadRefusal {
  const ext = /^.+\.([^.]+)$/.exec(filename)?.[1].toLowerCase() ?? "";
  if (!(UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
    return { code: "UNSUPPORTED_FORMAT", refusal:
      `ERROR: UNSUPPORTED_FORMAT — ${JSON.stringify(filename)} is not a plain-text file this platform takes; ` +
      `send a UTF-8 text file named with one of ${FAMILY}. Nothing is extracted from HTML, Office or PDF ` +
      "files: save the text itself under one of those names." };
  }
  if (bytes.length > UPLOAD_MAX_BYTES) {
    return { code: "SIZE_LIMIT", refusal:
      `ERROR: SIZE_LIMIT — ${JSON.stringify(filename)} is ${bytes.length} bytes, over the 8 MiB ` +
      `(${UPLOAD_MAX_BYTES}-byte) limit for one upload; send a smaller file, or split it into parts.` };
  }
  const bom = BOM.every((b, i) => bytes[i] === b);
  const rest = bom ? bytes.subarray(BOM.length) : bytes;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rest);
  } catch {
    return { code: "INVALID_ENCODING", refusal:
      `ERROR: INVALID_ENCODING — ${JSON.stringify(filename)} is not valid UTF-8; re-save it as UTF-8 text ` +
      "and send it again." };
  }
  const nul = text.indexOf("\u0000");
  if (nul >= 0) {
    return { code: "INVALID_ENCODING", refusal:
      `ERROR: INVALID_ENCODING — ${JSON.stringify(filename)} holds a NUL character (at character ${nul}), ` +
      "which no stored text can carry; send the file without NUL characters." };
  }
  return { text, bom };
}
