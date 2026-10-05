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
 * DELIBERATE: no PDF, and no dependency that reads one. A PDF is a program, not a document; the
 * parsers that read it are large, and the container this runs in holds the platform's database
 * credential — so a malformed PDF would be attacker-controlled input to a parser with the run of
 * that process. Say the format is not supported and let the uploader export it to text, which is
 * one command on their own machine and no risk to this one.
 */
import { inflateRawSync } from "node:zlib";

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

/** A file's bytes as the text a source holds, or the sentence that says why they are not.
 *
 *  `name` is only ever used for its extension: the uploader's own filename is not trusted to
 *  describe the bytes, but it is the only claim about them the platform has, and a mismatch costs
 *  the uploader their own material rather than anybody else's. */
export function extract(name: string, bytes: Buffer): { text: string } | { refusal: string } {
  const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "").trim();
  const unsupported = (why: string) =>
    ({ refusal: `${why} Upload a file this platform reads — Markdown, plain text, CSV, JSON, YAML, ` +
                "XML, SQL or HTML, or a .docx or an .odt — or export yours to one of those and " +
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
