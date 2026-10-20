/**
 * Prove that initiativeFrom names the initiative a call is about, and nothing it is not about.
 *
 *   node services/gateway/dist/call-attribution-check.js   # exits non-zero on failure
 *
 * Drives the real initiativeFrom, never a copy of its branches. The path cases are the bug this
 * was written for: a `document_read` of `<initiative>/<doc>.md` carries no `initiative`
 * argument, so the trace kept whatever initiative the caller had named before, and 113 of 1,009
 * such calls on production were filed under another one. The rest are the shapes the store
 * resolves to no initiative at all, and the answer route the path must not disturb.
 */
import { initiativeFrom } from "./call-attribution.js";

/** One MCP call, as the telemetry hands it over. */
function call(name: string, args: Record<string, unknown>) {
  return { params: { name, arguments: args } };
}

/** A streamed answer whose one text part is `body`, framed as the door frames it. */
function answer(body: unknown): string {
  return `data: ${JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify(body) }] } })}\n`;
}

const A = "2026-10-01-alpha";
const B = "2026-10-02-beta";

interface Case {
  name: string;
  wanted: ReturnType<typeof call>[];
  served: string | null;
  expect: string | null;
  why: string;
}

const CASES: Case[] = [
  {
    name: "a read of a document inside an initiative",
    wanted: [call("document_read", { path: `${A}/spec.md` })],
    served: null,
    expect: A,
    why: "the path's first segment is the initiative the store files the document under",
  },
  {
    name: "an edit of a document inside an initiative",
    wanted: [call("document_edit", { path: `${A}/plan.md` })],
    served: null,
    expect: A,
    why: "every document tool takes the same path, so every one names the same initiative",
  },
  {
    name: "a read of several documents in one initiative",
    wanted: [call("document_read", { path: [`${A}/spec.md`, `${A}/plan.md`] })],
    served: null,
    expect: A,
    why: "document_read and document_present take an array, and every entry names one initiative",
  },
  {
    name: "a path with a leading slash",
    wanted: [call("document_read", { path: `/${A}/spec.md` })],
    served: null,
    expect: A,
    why: "safePath strips leading slashes before the store splits the path",
  },
  {
    name: "a source inside an initiative",
    wanted: [call("document_read", { path: `${A}/sources/notes.md` })],
    served: null,
    expect: A,
    why: "a source is filed under the initiative its path starts with, however deep it sits",
  },
  {
    name: "a read of documents in two initiatives",
    wanted: [call("document_read", { path: [`${A}/spec.md`, `${B}/spec.md`] })],
    served: null,
    expect: null,
    why: "one row cannot carry two initiatives, so a path naming two names none",
  },
  {
    name: "an array where one entry names no initiative",
    wanted: [call("document_read", { path: [`${A}/spec.md`, "_knowledge/nodes/0001-x.md"] })],
    served: null,
    expect: null,
    why: "the initiative is taken only when every path names the same one",
  },
  {
    name: "an empty array",
    wanted: [call("document_read", { path: [] })],
    served: null,
    expect: null,
    why: "no path names nothing",
  },
  {
    name: "an initiative argument beside a path naming another",
    wanted: [call("source_add", { initiative: B, path: `${A}/sources/notes.md` })],
    served: null,
    expect: B,
    why: "the argument that says which initiative outranks the one a path implies",
  },
  {
    name: "a knowledge node on the team's shelf",
    wanted: [call("document_read", { path: "_knowledge/nodes/0034-some-node.md" })],
    served: null,
    expect: null,
    why: "_knowledge is the journal shelf, which is not an initiative",
  },
  {
    name: "a read on the platform shelf",
    wanted: [call("document_read", { path: `${A}/spec.md`, scope: "platform" })],
    served: null,
    expect: null,
    why: "scope: platform reads the shelf every team shares, never the caller's initiative",
  },
  {
    name: "a bare document name",
    wanted: [call("document_read", { path: "spec.md" })],
    served: null,
    expect: null,
    why: "a path with no initiative segment is not inside an initiative",
  },
  {
    name: "a path the store refuses for a dot segment",
    wanted: [call("document_write", { path: `${A}/.hidden.md` })],
    served: null,
    expect: null,
    why: "pathShapeRefusal refuses it, so the call reaches no initiative",
  },
  {
    name: "a path that is not a string",
    wanted: [call("document_read", { path: 42 })],
    served: null,
    expect: null,
    why: "only a string, or an array of strings, is a path",
  },
  {
    name: "an initiative argument alone",
    wanted: [call("document_list", { initiative: A })],
    served: null,
    expect: A,
    why: "the argument route is unchanged",
  },
  {
    name: "a status call on a slug nobody opened",
    wanted: [call("initiative_status", { initiative: B })],
    served: answer({ initiative: B, error: "no such initiative" }),
    expect: null,
    why: "an answer carrying an error names nothing, although it echoes the slug",
  },
  {
    name: "a status call that found the initiative",
    wanted: [call("initiative_status", { initiative: B })],
    served: answer({ initiative: B }),
    expect: B,
    why: "the answer is the authority for the two calls in ANSWER_NAMES_INITIATIVE",
  },
  {
    name: "a status call whose answer was not captured",
    wanted: [call("initiative_status", { initiative: B })],
    served: null,
    expect: null,
    why: "its argument is never read, captured answer or not",
  },
];

function main(): number {
  const failures: string[] = [];
  for (const c of CASES) {
    const got = initiativeFrom(c.wanted, c.served);
    if (got !== c.expect) {
      failures.push(`${c.name}: got ${JSON.stringify(got)}, expected ${JSON.stringify(c.expect)} — ${c.why}`);
    }
  }
  if (failures.length) {
    console.error(`\n  call-attribution: ${failures.length} case(s) failed\n`);
    for (const f of failures) console.error(`    ${f}`);
    console.error("");
    return 1;
  }
  console.log(`  call-attribution: ${CASES.length} cases pass — a call names the initiative its ` +
              "`initiative` argument or its path is inside, and nothing for a shelf, a bare name, " +
              "a refused path or a path across two initiatives");
  return 0;
}

process.exit(main());
