/**
 * What an uploaded file is worth as a source.
 *
 * A source is text: its body is what the knowledge index reads, what `document_revise` cites and
 * what a reader opens. So an upload is only useful once it is text — some files already are, the
 * two Office formats are a ZIP of XML, and everything else is refused by name with what to do
 * instead. Filing a file we could not read would write a source that says nothing, which is worse
 * than saying so.
 *
 * Why this exists at all: an MCP tool's arguments are the model's own output. A 600 KB report
 * therefore costs 600 KB of output tokens to attach, twice over once it is read back to check —
 * and a PDF's bytes cannot be produced that way at any price. The shell reads the file and this
 * turns it into the text `source_add` takes, so the model's whole part is one command.
 *
 * PDF: read, and still with no PDF engine. This file refused the format, on the grounds that a
 * PDF is a program rather than a document and that the parsers which render one are large and take
 * attacker-shaped input inside the process holding this deployment's database credential. That
 * protection was not free: it put the work on every uploader, and this platform's uploaders are
 * authenticated members of a controlled deployment, so the bytes are as trusted as the person who
 * sent them. What runs on them now is `fromPdf` below — the same shape as the ZIP reader, on the
 * same `node:zlib`: inflate the content streams, take the strings out of the text operators, and
 * give up. No font program is executed, no embedded file is opened, nothing recurses, and a
 * stream that cannot be read is a refusal rather than a partial source. A file this cannot read is
 * one the platform says it cannot read, which is the same sentence an uploader got before.
 */
import { inflateRawSync, inflateSync } from "node:zlib";

/** Formats that are already text, by extension. `.json` and `.xml` are read as written: they are
 *  legible, and stripping them would lose the structure a reader came for. */
const TEXT = new Set([
  "md", "markdown", "txt", "text", "rst", "adoc", "csv", "tsv", "log", "json", "yaml", "yml",
  "sql", "xml", "toml", "ini", "conf", "env",
]);

/** Where a `.docx` keeps its body, and where an `.odt` keeps its. */
const OFFICE: Record<string, string> = { docx: "word/document.xml", odt: "content.xml" };

/** The most a member may inflate out of one entry. A ZIP says how large it becomes, and a lie there
 *  is a decompression bomb: this is the cap that makes the lie cost a refusal instead of the
 *  container's memory. */
const MAX_INFLATED = 64 * 1024 * 1024;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#160": " ",
};

/** Markup to what a reader would have read: paragraphs on their own lines, tags gone, entities
 *  decoded. `breaks` are the tags that end a line of text in that format. */
function fromMarkup(xml: string, breaks: RegExp): string {
  return xml
    .replace(breaks, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#?\w+);/g, (whole, name: string) => ENTITIES[name] ?? whole)
    .split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** HTML to text, with the elements that separate content turned into line breaks first. */
function fromHtml(html: string): string {
  return fromMarkup(
    html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " "),
    /<\/?(p|div|br|li|tr|h[1-6]|section|article|blockquote)\b[^>]*>/gi,
  );
}

/** One entry out of a ZIP, or null when it is not there.
 *
 *  Written out rather than taken from a library: a `.docx` is a ZIP whose entries are stored or
 *  deflated, and the central directory is the whole of what reading one needs. Node inflates
 *  itself, and `maxOutputLength` is what bounds a bad size. */
export function zipEntry(zip: Buffer, want: string): Buffer | null {
  // The end-of-central-directory record is last, and a comment may follow it, so it is found from
  // the back. Its own fields are at a fixed offset: the entries, their size, and where they start.
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0 && i >= zip.length - 22 - 65_535; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;
    if (name !== want) continue;
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) return null;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + compressed);
    if (method === 0) return raw;
    if (method !== 8) return null;
    try {
      return inflateRawSync(raw, { maxOutputLength: MAX_INFLATED });
    } catch {
      return null;
    }
  }
  return null;
}

/** One PDF string literal, unescaped: `\n`, a bracketed character, and `\ooo` by the spec. */
function pdfString(raw: string): string {
  const NAMED: Record<string, string> = { n: "\n", r: "\n", t: "\t", b: "", f: "", "(": "(", ")": ")", "\\": "\\" };
  return raw.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g,
    (whole, esc: string) => (/^[0-7]/.test(esc) ? String.fromCharCode(parseInt(esc, 8)) : (NAMED[esc] ?? whole)));
}

/** What one content stream SHOWS, in reading order: `Tj` shows a string, a `TJ` array shows its
 *  strings with a kerning offset wide enough to be a space between them, and the operators that
 *  move the pen start a line. Everything else in the stream is drawing, and is ignored. */
function pdfContent(stream: string): string {
  const out: string[] = [];
  for (const m of stream.matchAll(/\[((?:\\.|[^\]\\])*)\]\s*TJ|\(((?:\\.|[^\\()])*)\)\s*Tj|\bT[dD]\b|\bT\*|'/g)) {
    if (m[1] !== undefined) {
      for (const piece of m[1].matchAll(/\((?:\\.|[^\\()])*\)|-?\d+(?:\.\d+)?/g)) {
        // A negative kern of about a tenth of the font size is how a word break is written in a
        // `TJ` array; less than that is letter spacing.
        out.push(piece[0].startsWith("(") ? pdfString(piece[0].slice(1, -1)) : (Number(piece[0]) <= -100 ? " " : ""));
      }
    } else if (m[2] !== undefined) out.push(pdfString(m[2]));
    else out.push("\n");
  }
  return out.join("");
}

/** The text a PDF's streams carry, or null where none of them yields any.
 *
 *  DELIBERATE: `latin1`, so every byte survives as one character and the offsets `matchAll`
 *  reports are the bytes `inflateSync` needs. A stream that does not inflate is read as it stands,
 *  because an uncompressed content stream is legal: a font or image that reaches this contributes
 *  nothing, since the operator scan finds none of its own in it. */
function fromPdf(bytes: Buffer): string | null {
  const raw = bytes.toString("latin1");
  const parts: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    let stream: string;
    try {
      // Capped, like the ZIP above: a PDF says how large its stream becomes, and a lie there is
      // a bomb rather than a document. Past the cap `inflateSync` throws, and the stream is then
      // read as it stands — the compressed bytes, which cost nothing.
      stream = inflateSync(Buffer.from(m[1], "latin1"), { maxOutputLength: MAX_INFLATED }).toString("latin1");
    } catch {
      stream = m[1];
    }
    const text = pdfContent(stream);
    if (text.trim()) parts.push(text);
  }
  const text = parts.join("\n").replace(/[ \t]+/g, " ").split("\n").map((l) => l.trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim();
  // Letters or figures, or this is not a document anybody can read: an empty extraction is a
  // refusal, never a source holding nothing.
  return /[A-Za-z]{3}|\d{3}/.test(text) ? text : null;
}

/** A file's bytes as the text a source holds, or the sentence that says why they are not.
 *
 *  `name` is only ever used for its extension: the uploader's own filename is not trusted to
 *  describe the bytes, but it is the only claim about them the platform has, and a mismatch costs
 *  the uploader their own material rather than anybody else's. */
export function extract(name: string, bytes: Buffer): { text: string } | { refusal: string } {
  const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "").trim();
  const unsupported = (why: string) =>
    ({ refusal: `${why} Upload a file this platform reads — Markdown, plain text, CSV, JSON, YAML, ` +
                "XML, SQL or HTML, or a .docx, an .odt or a .pdf — or export yours to one of " +
                "those and " +
                "upload that." });

  if (!ext) return unsupported(`"${name}" has no extension, so there is no telling what it holds.`);
  const office = OFFICE[ext];
  if (office) {
    const xml = zipEntry(bytes, office);
    if (!xml) return unsupported(`"${name}" is not a readable .${ext} — it is not a ZIP carrying ${office}.`);
    const text = fromMarkup(xml.toString("utf8"), /<\/[a-z0-9]+:(p|h|tr|table)>/gi);
    if (!text) return unsupported(`"${name}" carries no text this platform can read.`);
    return { text };
  }
  if (ext === "pdf") {
    const text = fromPdf(bytes);
    if (!text) return unsupported(`"${name}" carries no text this platform can read — it is a PDF ` +
      "whose pages hold no text layer, or one this reader cannot open. A scan of a page has no text " +
      "in it at all; running it through OCR first is what makes a document out of it.");
    return { text };
  }
  if (ext === "html" || ext === "htm") {
    const text = fromHtml(bytes.toString("utf8"));
    if (!text) return unsupported(`"${name}" carries no text this platform can read.`);
    return { text };
  }
  if (TEXT.has(ext)) {
    const text = bytes.toString("utf8").replace(/\u0000/g, "").trim();
    if (!text) return unsupported(`"${name}" is empty — there is nothing in it to file as a source.`);
    // A file that decoded to replacement characters was not text, whatever its name said.
    if (/�{3}/.test(text)) {
      return unsupported(`"${name}" is not text — it decodes to bytes this platform cannot read.`);
    }
    return { text };
  }
  return unsupported(`"${name}" is a .${ext} file, which this platform does not read.`);
}
