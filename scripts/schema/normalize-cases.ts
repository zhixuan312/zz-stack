/**
 * The normalisation cases of `checks/document-normalize.ts` (AC-2.1), through a real zz-core on a
 * throwaway database: input the platform can read exactly one way is taken that way and reported,
 * and input it cannot is refused by name — never guessed at, never dropped.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs, so the case groups
 * that check runs live here, beside the harness they run on. The read helpers at the top are the
 * ones `details-cases.ts` uses too.
 */
import { documentBody } from "@zz/contracts";

import type { Core } from "./throwaway-core.ts";

export const first = (reply: string): string => reply.split("\n")[0];
export const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every key the platform writes or renders into an envelope — the decision's list. Sent in
 *  content, each is ignored and reported; none is ever taken. */
const PLATFORM_KEYS = ["flow", "type", "status", "version", "updated_at", "approved_by", "approved_at", "outcome",
  "closed_by", "accepted_by", "no_signoff_reason", "content_revision", "revision_note", "sources", "date", "added_at",
  "contributed_by", "supports", "stage", "audits_version", "evidence", "supersededBy", "verified_against", "eval_run_id"];

/** The body a read returns, every byte of it. */
async function bodyOf(c: Core, step: string, path: string): Promise<string> {
  return documentBody(await c.ok(step, "document_read", { path }));
}

/** The content revision a read of the current document states. */
async function tokenOf(c: Core, step: string, path: string): Promise<string> {
  const read = await c.ok(step, "document_read", { path });
  return /^content_revision: (cr_[a-z2-7]{26})$/m.exec(read)?.[1] ?? c.fail(step, `no content_revision in: ${read}`);
}

/** A `document_edit` refusal that leaves the document exactly as it was: body and content revision. */
export async function refusedUnchanged(c: Core, step: string, path: string, args: Record<string, unknown>,
                                       expect: RegExp): Promise<string> {
  const before = { body: await bodyOf(c, step, path), token: await tokenOf(c, step, path) };
  const reply = await c.refused(step, "document_edit", { path, ...args }, expect);
  if (await bodyOf(c, step, path) !== before.body) c.fail(step, `the refused call changed the body: ${reply}`);
  if (await tokenOf(c, step, path) !== before.token) c.fail(step, `the refused call moved the content revision: ${reply}`);
  return reply;
}

/** `source_add` for each of `args`, five callers at a time, each on its own session: the paths
 *  recorded, in the order asked. */
export async function addSources(c: Core, step: string, args: Record<string, unknown>[]): Promise<string[]> {
  const lanes = Array.from({ length: 5 }, () => c.client());
  const out: string[] = new Array<string>(args.length);
  await Promise.all(lanes.map(async (via, lane) => {
    for (let i = lane; i < args.length; i += lanes.length) out[i] = await c.source(step, args[i], via);
  }));
  return out;
}

/** A refused create left no document behind. */
async function absent(c: Core, step: string, path: string): Promise<void> {
  const read = await c.call(step, "document_read", { path });
  if (!read.startsWith("ERROR")) c.fail(step, `a refused create left ${path} behind: ${read}`);
}

/** The entries of a counted list line, `<label> (<n>): <a><sep><b>…`: its total and its entries. */
function listed(reply: string, label: string, sep = ", "): { total: number; items: string[] } | null {
  const m = new RegExp(`^${esc(label)} \\((\\d+)\\): (.*)$`, "m").exec(reply);
  if (!m) return null;
  return { total: Number(m[1]), items: m[2] === "none" ? [] : m[2].split(sep) };
}

/** The envelope keys a read rendered, in order. */
function envelopeKeys(read: string): string[] {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(read)?.[1] ?? "";
  return block.split(/\r?\n/).map((l) => /^([A-Za-z0-9_-]+):/.exec(l)?.[1]).filter((k): k is string => !!k);
}

export async function normalisationCases(c: Core): Promise<void> {
  const I = await c.open("normalise");

  let step = "document_write: an envelope after blank lines, in CRLF, is separated — title, tags, stakeholder and a flow field taken, each reported, the body byte for byte";
  const a = `${I}/taken.md`;
  let reply = await c.ok(step, "document_write", { path: a,
    content: "\r\n\r\n---\r\ntitle: Taken Title\r\ntags: Alpha, beta\r\nstakeholder: Ana\r\ncomponent: billing\r\n---\r\n# Taken\r\n\r\nbody\r\n" });
  let list = listed(reply, "normalised", "; ") ?? c.fail(step, `no normalised line: ${reply}`);
  for (const want of ["took title from the content's envelope", "took tags from the content's envelope",
                      'tag "Alpha" lower-cased to "alpha"', "took stakeholder from the content's envelope",
                      "took component from the content's envelope"]) {
    if (!list.items.includes(want)) c.fail(step, `\`${want}\` is not reported: ${reply}`);
  }
  if (list.total !== 5 || list.items.length !== 5) c.fail(step, `expected 5 normalisations, each one line: ${reply}`);
  let read = await c.ok(step, "document_read", { path: a });
  for (const line of ["title: Taken Title", "tags: alpha, beta", "stakeholder: Ana", "component: billing"]) {
    if (!new RegExp(`^${esc(line)}$`, "m").test(read)) c.fail(step, `no \`${line}\` in: ${read}`);
  }
  if (documentBody(read) !== "# Taken\r\n\r\nbody\r\n") c.fail(step, `the body: ${JSON.stringify(documentBody(read))}`);
  c.pass(step);

  step = "a named argument agreeing with the envelope is reported; one that differs is METADATA_CONFLICT naming both values — title, tags, stakeholder and a field in one answer — and nothing is written, on either tool";
  reply = await c.ok(step, "document_write", { path: `${I}/agrees.md`, title: "Same", tags: ["gamma"],
    content: "---\ntitle: Same\ntags: Gamma\n---\n# Agrees\n" });
  for (const want of ["title from the content's envelope agrees with the named argument",
                      "tags from the content's envelope agrees with the named argument"]) {
    if (!(listed(reply, "normalised", "; ")?.items ?? []).includes(want)) c.fail(step, `\`${want}\`: ${reply}`);
  }
  const conflicting = { title: "Named", tags: ["named"], stakeholder: "Bo", fields: { component: "named" },
    content: "---\ntitle: Envelope\ntags: envelope\nstakeholder: Ana\ncomponent: envelope\n---\n# Conflict\n" };
  const conflicts = [/^ERROR: METADATA_CONFLICT — title is "Envelope" in the content's envelope and "Named" as the named argument `title`/m,
    /^ERROR: METADATA_CONFLICT — tags is "envelope" in the content's envelope and "named" as the named argument `tags`/m,
    /^ERROR: METADATA_CONFLICT — stakeholder is "Ana" in the content's envelope and "Bo" as the named argument `stakeholder`/m,
    /^ERROR: METADATA_CONFLICT — component is "envelope" in the content's envelope and "named" as the named argument `fields\.component`/m];
  reply = await c.refused(step, "document_write", { path: `${I}/conflict.md`, ...conflicting }, /^ERROR: METADATA_CONFLICT/);
  for (const want of conflicts) if (!want.test(reply)) c.fail(step, `${want} is not reported: ${reply}`);
  await absent(c, step, `${I}/conflict.md`);
  reply = await refusedUnchanged(c, step, a, conflicting, /^ERROR: METADATA_CONFLICT/);
  for (const want of conflicts) if (!want.test(reply)) c.fail(step, `document_edit: ${want} is not reported: ${reply}`);
  c.pass(step);

  step = "every key the platform writes or renders is ignored and reported, none reaches the stored envelope, and a `sources:` line names no cause";
  const src = await c.source(step, { initiative: I, title: "Not a cause", content: "material" });
  const planted = PLATFORM_KEYS.map((k) => `${k}: ${k === "sources" ? src.slice(I.length + 1) : `planted-${k}`}`);
  reply = await c.ok(step, "document_edit", { path: a, content: `---\n${planted.join("\n")}\n---\n# Taken\n\nnew body\n` });
  list = listed(reply, "normalised", "; ") ?? c.fail(step, `no normalised line: ${reply}`);
  for (const k of PLATFORM_KEYS) {
    if (!list.items.includes(`ignored ${k} from the content's envelope — the platform writes it`)) c.fail(step, `${k} is not reported: ${reply}`);
  }
  if (list.total !== PLATFORM_KEYS.length || !/^causes \(0\): none$/m.test(reply)) c.fail(step, reply);
  read = await c.ok(step, "document_read", { path: a });
  if (/planted-/.test(read)) c.fail(step, `a platform key reached the stored envelope: ${read}`);
  if ((await c.cites(a)).length) c.fail(step, `a \`sources:\` line was taken as a cause: ${(await c.cites(a)).join(" | ")}`);
  if (documentBody(read) !== "# Taken\n\nnew body\n") c.fail(step, `the body: ${JSON.stringify(documentBody(read))}`);
  c.pass(step);

  step = "a key no document records is UNSUPPORTED_METADATA naming every one — a paragraph between two thematic breaks whose lines read `Word: text` among them — never dropped, on either tool";
  const unknown = /^ERROR: UNSUPPORTED_METADATA — the content's envelope carries "Author", "Reviewer", which no document records/;
  const paragraph = "---\nAuthor: Ana\nReviewer: Bo\n---\n\n# Notes\n";
  await refusedUnchanged(c, step, a, { content: paragraph }, unknown);
  await c.refused(step, "document_write", { path: `${I}/unknown.md`, content: paragraph }, unknown);
  await absent(c, step, `${I}/unknown.md`);
  c.pass(step);

  step = "plain text that starts with `---` is the body, byte for byte, on both tools: a thematic break, YAML that is not a key block, SQL between rules";
  const literal = [
    "---\n\n# After a rule\n\ntext\n",
    "---\nservices:\n  web:\n    image: nginx\n    ports:\n      - \"80:80\"\n---\n",
    "---\n- name: first\n  value: 1\n- name: second\n  value: 2\n",
    "---\nCREATE TABLE note (id int, body text);\n-- status: kept as text\nSELECT id, body FROM note WHERE id = 1;\n---\n",
  ];
  const l = `${I}/literal.md`;
  await c.ok(step, "document_write", { path: l, content: "# Literal\n" });
  for (const [i, body] of literal.entries()) {
    const w = `${I}/literal-${i}.md`;
    reply = await c.ok(step, "document_write", { path: w, content: body });
    if (!/^normalised \(0\): none$/m.test(reply) || await bodyOf(c, step, w) !== body) c.fail(step, `document_write ${JSON.stringify(body)}: ${reply}`);
    reply = await c.ok(step, "document_edit", { path: l, content: body });
    if (!/^normalised \(0\): none$/m.test(reply) || await bodyOf(c, step, l) !== body) c.fail(step, `document_edit ${JSON.stringify(body)}: ${reply}`);
  }
  // An edit batch making a body open with YAML that is not a key block keeps it as written too.
  await c.ok(step, "document_edit", { path: l, content: "# Literal\n" });
  await c.ok(step, "document_edit", { path: l, edits: [{ find: "# Literal\n", replace: `${literal[1]}# Literal\n` }] });
  if (await bodyOf(c, step, l) !== `${literal[1]}# Literal\n`) c.fail(step, `the batch's body: ${await bodyOf(c, step, l)}`);
  c.pass(step);

  step = "tags in another case are lower-cased and reported on both tools; a tag lower-casing cannot fix is refused by name";
  reply = await c.ok(step, "document_write", { path: `${I}/tagged.md`, content: "# Tagged\n", tags: ["Alpha", "BETA-2", "gamma"] });
  list = listed(reply, "normalised", "; ") ?? c.fail(step, reply);
  if (list.total !== 2 || !list.items.includes('tag "Alpha" lower-cased to "alpha"') || !list.items.includes('tag "BETA-2" lower-cased to "beta-2"')) c.fail(step, reply);
  reply = await c.ok(step, "document_edit", { path: `${I}/tagged.md`, tags: ["Delta"] });
  if (!/^normalised \(1\): tag "Delta" lower-cased to "delta"$/m.test(reply)) c.fail(step, reply);
  if (!/^tags: delta$/m.test(await c.ok(step, "document_read", { path: `${I}/tagged.md` }))) c.fail(step, "the tags were not stored lower-cased");
  await refusedUnchanged(c, step, `${I}/tagged.md`, { tags: ["Not A Tag"] }, /^ERROR: "not a tag" is not a tag/);
  c.pass(step);

  step = "a `sources` or `supports` entry spelt with `./`, its own initiative's prefix or no extension is read canonically and reported; another initiative's, `..` and an absolute path are refused, every one at once";
  const s1 = (await c.source(step, { initiative: I, title: "Spelt one", content: "one" })).slice(I.length + 1);
  const s2 = (await c.source(step, { initiative: I, title: "Spelt two", content: "two" })).slice(I.length + 1);
  const s3 = (await c.source(step, { initiative: I, title: "Spelt three", content: "three" })).slice(I.length + 1);
  const spelt = [`./${s1}`, `${I}/${s2}`, s3.replace(/\.md$/, "")];
  reply = await c.ok(step, "document_edit", { path: l, edits: [{ find: "# Literal", replace: "# Literal, caused" }], sources: spelt });
  list = listed(reply, "normalised", "; ") ?? c.fail(step, reply);
  for (const [sent, as] of [[spelt[0], s1], [spelt[1], s2], [spelt[2], s3]]) {
    if (!list.items.includes(`"${sent}" read as "${as}"`)) c.fail(step, `"${sent}" is not reported as "${as}": ${reply}`);
  }
  if (!/^causes \(3\): /m.test(reply) || ![s1, s2, s3].every((s) => reply.includes(`${I}/${s} (agent)`))
      || (await c.cites(l)).length !== 3) c.fail(step, `the three are not causes: ${reply}`);
  reply = await refusedUnchanged(c, step, l, { edits: [{ find: "caused", replace: "x" }],
    sources: ["2026-01-01-elsewhere/sources/x.md", "../x.md", "/etc/x.md"] }, /^ERROR: INVALID_MODE — source/);
  for (const why of ["names a document of another initiative, 2026-01-01-elsewhere", "climbs out with `..`", "is an absolute path"]) {
    if (!reply.includes(why)) c.fail(step, `\`${why}\` is not reported: ${reply}`);
  }
  reply = await c.call(step, "source_add", { initiative: I, title: "Supports spelt", content: "x", supports: ["./taken", `${I}/literal.md`] });
  if (!/^supports \(2\): taken\.md, literal\.md$/m.test(reply) || !reply.includes('"./taken" read as "taken.md"')
      || !reply.includes(`"${I}/literal.md" read as "literal.md"`)) c.fail(step, reply);
  c.pass(step);

  step = "normalisation never manufactures a version: the body sent again under an envelope repeating its metadata, or its tags in another case, is no_change";
  const token = await tokenOf(c, step, `${I}/tagged.md`);
  for (const args of [{ content: "---\ntitle: Tagged\ntags: DELTA\n---\n# Tagged\n" }, { tags: ["DELTA"] }]) {
    reply = await c.ok(step, "document_edit", { path: `${I}/tagged.md`, ...args });
    if (first(reply) !== `edited: ${I}/tagged.md — v1 (no change)` || !reply.includes(`content revision: ${token}`)) c.fail(step, reply);
  }
  c.pass(step);

  step = "a source name taken today is suffixed under the lock: three concurrent source_add calls of one title file three names";
  const filed = await Promise.all([c.mcp, c.client(), c.client()].map((via) =>
    c.source(step, { initiative: I, title: "Same title", content: "concurrent" }, via)));
  const stem = filed.map((f) => f.replace(/(-[23])?\.md$/, "")).sort();
  if (new Set(filed).size !== 3 || new Set(stem).size !== 1
      || ![".md", "-2.md", "-3.md"].every((end) => filed.some((f) => f === `${stem[0]}${end}`))) c.fail(step, filed.join(" | "));
  c.pass(step);

  step = "document_read → document_edit(content: <the text read>) is no_change, every key the read rendered reported, each platform key as ignored";
  const r = `${I}/round-trip.md`;
  await c.ok(step, "document_write", { path: r, content: "# Round trip\n\nfirst\n", title: "Round trip", tags: ["alpha"],
                                        stakeholder: "Ana", fields: { component: "billing" }, sources: [s1] });
  await c.ok(step, "document_edit", { path: r, edits: [{ find: "first", replace: "second" }], note: "the second wording", sources: [s2] });
  const whole = await c.ok(step, "document_read", { path: r });
  const keys = envelopeKeys(whole);
  for (const k of ["revision_note", "sources", "content_revision", "version", "title", "tags", "stakeholder", "component"]) {
    if (!keys.includes(k)) c.fail(step, `the read rendered no \`${k}\`, so the round trip proves less than it says: ${whole}`);
  }
  const before = await tokenOf(c, step, r);
  reply = await c.ok(step, "document_edit", { path: r, content: whole });
  if (first(reply) !== `edited: ${r} — v2 (no change)` || !reply.includes(`content revision: ${before}`)) c.fail(step, reply);
  list = listed(reply, "normalised", "; ") ?? c.fail(step, reply);
  if (list.total !== keys.length || list.items.length !== keys.length) c.fail(step, `${keys.length} keys rendered (${keys.join(", ")}): ${reply}`);
  for (const k of keys) {
    const said = PLATFORM_KEYS.includes(k)
      ? list.items.includes(`ignored ${k} from the content's envelope — the platform writes it`)
      : list.items.some((x) => x.startsWith(`took ${k} `) || x.startsWith(`${k} from the content's envelope agrees`));
    if (!said) c.fail(step, `\`${k}\` is not reported as it should be: ${reply}`);
  }
  c.pass(step);
}
