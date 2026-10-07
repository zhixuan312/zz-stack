#!/usr/bin/env node
/**
 * The plain-text family every upload route goes through (`uploadText` in `@zz/contracts`): exactly
 * FR-16's extensions and no other — `.env` and the retired HTML, Office and PDF readers included —
 * at most 8 MiB, strict UTF-8, a leading BOM removed and reported, and nothing else about the text
 * changed: no trimming, no NUL stripping, no line-ending rewrite. A NUL is refused by name, because
 * no stored text can carry one. Also the formats the staging routes and `upload_start` share: an
 * upload id is `up_` and 26 base32 characters, a link secret `us_` and 52, and only the secret's
 * sha256 is ever stored.
 *
 * Pure: no database, no network.
 * Run: node checks/upload-text.ts   (also run by scripts/gate.ts)
 */
import { createHash } from "node:crypto";

import { mintUploadId, mintUploadSecret, UPLOAD_EXTENSIONS, UPLOAD_ID, UPLOAD_MAX_BYTES, UPLOAD_SECRET,
         uploadExtension, uploadSecretHash, uploadText } from "@zz/contracts";

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };
const utf8 = (s: string) => new TextEncoder().encode(s);
type Read = { text: string; bom: boolean } | { code: string; refusal: string };
const read = (name: string, bytes: Uint8Array): Read => uploadText(name, bytes) as Read;
const refused = (name: string, bytes: Uint8Array, code: string, why: string) => {
  const r = read(name, bytes);
  is("code" in r && r.code === code && r.refusal.startsWith(`ERROR: ${code} — `),
     `${why}: expected ${code}, got ${JSON.stringify(r).slice(0, 200)}`);
};
const accepted = (name: string, bytes: Uint8Array, text: string, bom: boolean, why: string) => {
  const r = read(name, bytes);
  is("text" in r && r.text === text && r.bom === bom, `${why}: got ${JSON.stringify(r).slice(0, 200)}`);
};

// FR-16's list, written out here rather than read from the module it judges.
const FR16 = ["md", "markdown", "txt", "text", "csv", "tsv", "json", "yaml", "yml", "toml", "xml", "sql",
              "log", "ini", "conf", "rst", "adoc"];
is(JSON.stringify([...UPLOAD_EXTENSIONS].sort()) === JSON.stringify([...FR16].sort()),
   `the family is FR-16's list exactly: ${JSON.stringify(UPLOAD_EXTENSIONS)}`);
for (const ext of FR16) {
  accepted(`notes.${ext}`, utf8("a,b\n"), "a,b\n", false, `.${ext} is in the family`);
  accepted(`NOTES.${ext.toUpperCase()}`, utf8("x"), "x", false, `.${ext.toUpperCase()} is the same extension`);
}
for (const name of ["x.env", ".env", "x.html", "x.htm", "x.docx", "x.odt", "x.pdf", "x.rtf", "README", ".md",
                    "x.md.exe", "x.", ""]) {
  refused(name, utf8("plain"), "UNSUPPORTED_FORMAT", `${JSON.stringify(name)} is outside the family`);
}
// The extension rule the gateway's sent-name check shares with uploadText.
for (const [name, ext] of [["notes.MD", "md"], ["a.b.Txt", "txt"], [".env", ""], [".md", ""], ["x.", ""], ["README", ""],
                           ["", ""]]) {
  is(uploadExtension(name) === ext, `uploadExtension(${JSON.stringify(name)}) is ${JSON.stringify(uploadExtension(name))}, not ${JSON.stringify(ext)}`);
}
const fmt = read("report.pdf", utf8("x"));
is("refusal" in fmt && fmt.refusal.includes(".md") && fmt.refusal.includes(".adoc") && fmt.refusal.includes("report.pdf"),
   `an unsupported format names the file and what to send: ${JSON.stringify(fmt)}`);

// The size limit is on the bytes as sent, BOM included, and the boundary is inclusive.
const exact = new Uint8Array(UPLOAD_MAX_BYTES).fill(0x61);
is(UPLOAD_MAX_BYTES === 8 * 1024 * 1024, `the limit is 8 MiB: ${UPLOAD_MAX_BYTES}`);
const full = read("big.txt", exact);
is("text" in full && full.text.length === UPLOAD_MAX_BYTES, "exactly 8 MiB is accepted");
refused("big.txt", new Uint8Array(UPLOAD_MAX_BYTES + 1).fill(0x61), "SIZE_LIMIT", "one byte past 8 MiB");
const size = read("big.txt", new Uint8Array(UPLOAD_MAX_BYTES + 1).fill(0x61));
is("refusal" in size && /8 MiB/.test(size.refusal), `the size refusal names the limit: ${JSON.stringify(size)}`);

// Strict UTF-8: a lone continuation byte, an overlong form, a truncated sequence, a surrogate.
for (const [bad, why] of [[[0x61, 0x80, 0x62], "a lone continuation byte"], [[0xc0, 0xaf], "an overlong slash"],
                          [[0xe2, 0x82], "a truncated sequence"], [[0xed, 0xa0, 0x80], "an encoded surrogate"],
                          [[0xef, 0xbf, 0xbd, 0xff], "a valid U+FFFD followed by 0xFF"]] as [number[], string][]) {
  refused("bad.txt", new Uint8Array(bad), "INVALID_ENCODING", why);
}
// A file that merely holds U+FFFD three times is valid UTF-8 — the old heuristic refused it.
accepted("ok.txt", utf8("\uFFFD\uFFFD\uFFFD"), "\uFFFD\uFFFD\uFFFD", false, "valid U+FFFD characters are text");
refused("nul.txt", utf8("a\u0000b"), "INVALID_ENCODING", "a NUL byte, which no stored text can carry");
const nul = read("nul.txt", utf8("ab\u0000"));
is("refusal" in nul && /NUL/.test(nul.refusal), `the NUL refusal says NUL: ${JSON.stringify(nul)}`);

// A leading BOM is removed and reported; one anywhere else is text.
accepted("bom.md", new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("# T\n")]), "# T\n", true, "a leading BOM is removed and reported");
accepted("mid.md", utf8("a\uFEFFb"), "a\uFEFFb", false, "a BOM past the start is kept");
accepted("two.md", new Uint8Array([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x78]), "\uFEFFx", true,
         "only the first of two leading BOMs is removed");
accepted("only.txt", new Uint8Array([0xef, 0xbb, 0xbf]), "", true, "a file that is only a BOM becomes empty, reported");

// Nothing else changes: surrounding whitespace, CRLF, tabs, a YAML fence, markup — all kept as sent.
for (const [name, text] of [["s.txt", "  \n\tpadded\r\n\r\n  "], ["f.yaml", "---\nkey: v\n---\n"],
                            ["x.xml", "<a><script>alert(1)</script></a>"], ["e.md", ""], ["u.md", "中文🙂\r\n"]]) {
  accepted(name, utf8(text), text, false, `${name} round-trips byte for byte`);
}

// The formats. An upload id names one upload in transcripts; the link secret authorises staging it.
const ids = new Set(Array.from({ length: 200 }, () => mintUploadId()));
is(ids.size === 200 && [...ids].every((id) => UPLOAD_ID.test(id) && /^up_[a-z2-7]{26}$/.test(id)),
   `upload ids are up_ and 26 base32 characters, never repeating: ${[...ids][0]}`);
const secrets = Array.from({ length: 50 }, () => mintUploadSecret());
is(secrets.every((s) => UPLOAD_SECRET.test(s) && /^us_[a-z2-7]{52}$/.test(s)) && new Set(secrets).size === 50,
   `link secrets are us_ and 52 base32 characters: ${secrets[0]}`);
is(!UPLOAD_ID.test(secrets[0]) && !UPLOAD_SECRET.test([...ids][0]), "an id is never a secret, nor a secret an id");
is(!UPLOAD_ID.test(`${[...ids][0]}x`) && !UPLOAD_SECRET.test(` ${secrets[0]}`), "the formats are anchored");
is(uploadSecretHash(secrets[0]) === createHash("sha256").update(secrets[0], "utf8").digest("hex"),
   "uploadSecretHash is the sha256 hex of the secret's UTF-8");

if (fail.length) {
  console.error(`upload-text: ${fail.length} failure(s)\n  - ${fail.join("\n  - ")}`);
  process.exit(1);
}
console.log("upload-text: exactly the plain-text family, at most 8 MiB, strict UTF-8, a BOM removed and reported, nothing else changed");
