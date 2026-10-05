/**
 * Prove that an uploaded file becomes the text a source holds, or a refusal that says why.
 *
 *   npm run check:extract      # exits non-zero on failure, like every engine here
 *
 * This drives the real `extract`, never a copy of its branches, over the shapes an upload actually
 * arrives as: the formats that are already text, HTML with its markup taken off, a `.docx` and an
 * `.odt` read out of their ZIP, and the four ways it must refuse — an extension it does not read,
 * no extension at all, a file whose name says text and whose bytes are not, and a ZIP that is not
 * the Office document it claims to be.
 *
 * The ZIP here is built to APPNOTE rather than by the reader under test: local header, central
 * directory, end record, with the entries deflated by Node's own zlib. A fixture written by the
 * same misunderstanding as the reader would pass either way.
 *
 * The last case is the one that is a safety property rather than a correctness one: an entry whose
 * deflated bytes expand past the cap is refused, not allocated. A `.docx` is attacker-controlled
 * input to this process, and the process holds the platform's database credential.
 */
import { deflateRawSync } from "node:zlib";

import { extract, zipEntry } from "./extract.js";

/** One entry of a ZIP, written the way APPNOTE 4.3.6 and 4.3.7 say. */
function zip(entries: { name: string; body: Buffer; store?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = e.store ? e.body : deflateRawSync(e.body);
    const name = Buffer.from(e.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(e.store ? 0 : 8, 8);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(e.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, raw);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(e.store ? 0 : 8, 10);
    dir.writeUInt32LE(raw.length, 20);
    dir.writeUInt32LE(e.body.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += 30 + name.length + raw.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const DOCX = zip([
  { name: "[Content_Types].xml", body: Buffer.from("<Types/>") },
  { name: "word/document.xml", body: Buffer.from(
      "<w:document><w:body><w:p><w:r><w:t>Handover</w:t></w:r></w:p>" +
      "<w:p><w:r><w:t>Two &amp; three</w:t></w:r></w:p></w:body></w:document>") },
]);
const ODT = zip([
  { name: "mimetype", body: Buffer.from("application/vnd.oasis.opendocument.text"), store: true },
  { name: "content.xml", body: Buffer.from(
      "<office:document-content><text:p>Minutes</text:p><text:p>Present: two</text:p></office:document-content>") },
]);

const CASES: { what: string; run: () => { text?: string; refusal?: string }; want: string | RegExp }[] = [
  { what: "markdown is its own text", run: () => extract("notes.md", Buffer.from("# Title\n\nBody.\n")), want: "# Title\n\nBody." },
  { what: "plain text is its own text", run: () => extract("call.txt", Buffer.from("  said it  ")), want: "said it" },
  { what: "csv is read as written", run: () => extract("rows.csv", Buffer.from("a,b\n1,2\n")), want: "a,b\n1,2" },
  { what: "html loses its markup and keeps its words", run: () => extract("page.html", Buffer.from("<h1>Hi</h1><p>a &amp; b</p><script>var x=1</script>")), want: "Hi\n\na & b" },
  { what: "a .docx is read out of its zip", run: () => extract("handover.docx", DOCX), want: "Handover\nTwo & three" },
  { what: "an .odt is read out of its zip", run: () => extract("minutes.odt", ODT), want: "Minutes\nPresent: two" },
  { what: "a pdf is refused by name", run: () => extract("signed.pdf", Buffer.from("%PDF-1.7 \xff\xfe")), want: /\.pdf file, which this platform does not read/ },
  { what: "a name with no extension is refused", run: () => extract("README", Buffer.from("hi")), want: /has no extension/ },
  { what: "a .txt that is not text is refused", run: () => extract("bytes.txt", Buffer.from([0xff, 0xfe, 0x00, 0xff, 0xfe, 0x00])), want: /is not text/ },
  { what: "an empty file is refused as empty, not as unreadable", run: () => extract("blank.md", Buffer.from("  \n\t\n")), want: /is empty/ },
  { what: "a zip that is not the Office document it claims is refused", run: () => extract("x.docx", zip([{ name: "other.xml", body: Buffer.from("<a/>") }])), want: /is not a readable \.docx/ },
  { what: "an empty Office document is refused", run: () => extract("x.docx", zip([{ name: "word/document.xml", body: Buffer.from("<w:body/>") }])), want: /carries no text/ },
  // 70 MB of zeros deflates to a few hundred bytes: the cap is what stops the reader allocating it.
  { what: "an entry that expands past the cap is refused, not allocated", run: () => extract("bomb.docx", zip([{ name: "word/document.xml", body: Buffer.alloc(70 * 1024 * 1024) }])), want: /is not a readable \.docx/ },
];

function main(): number {
  const failures: string[] = [];
  for (const c of CASES) {
    let got: string;
    try {
      const r = c.run();
      got = "text" in r ? (r.text ?? "") : (r.refusal ?? "");
    } catch (err) {
      failures.push(`${c.what} — threw ${String(err)}`);
      continue;
    }
    const ok = typeof c.want === "string" ? got === c.want : c.want.test(got);
    if (!ok) failures.push(`${c.what} — wanted ${String(c.want)}, got ${JSON.stringify(got.slice(0, 120))}`);
  }
  // The reader itself, on the shape a `.docx` really has: entries that are not the one wanted come
  // first, and the one that is wanted is stored rather than deflated.
  if (!zipEntry(DOCX, "word/document.xml")) failures.push("zipEntry did not find an entry that is there");
  if (zipEntry(DOCX, "word/nope.xml")) failures.push("zipEntry found an entry that is not there");
  if (!zipEntry(ODT, "mimetype")) failures.push("zipEntry did not find a STORED entry");

  if (failures.length) {
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(`\nextract: ${failures.length} of ${CASES.length} cases failed`);
    return 1;
  }
  console.log(`  extract: ${CASES.length} cases, both zip lookups and the expansion cap pass — a file becomes text or a refusal that names why`);
  return 0;
}

process.exit(main());
