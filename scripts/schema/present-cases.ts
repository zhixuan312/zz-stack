/**
 * The case groups of `checks/document-present-changes.ts` (AC-3.1, AC-3.2), through a real zz-core
 * on a throwaway database.
 *
 * Presenting what changed: a review context's covered baseline advances with every complete delta,
 * every kind of change is in the delta, a new context is shown everything, a partial presentation
 * pins the snapshot it cut, and a context is the caller's own — the same principal under the same
 * credential kind — and nobody else's.
 *
 * Approving what was shown: an approval signs exactly the snapshot a review context of the caller's
 * covered — never a newer one, never on somebody else's coverage — and a race with an edit, on the
 * document's own lock, signs only the snapshot presented or nothing. With them, the records a
 * presentation leaves: a legacy row's identity, a ticketless record refused, and its sizes.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs, so the case groups
 * that check runs live here, beside the harness they run on.
 */
import { documentBody } from "@zz/contracts";
import type { Mcp } from "@zz/mcp-client";

import { esc, first } from "./normalize-cases.ts";
import type { Core } from "./throwaway-core.ts";

/** A present's facts line, `Review context: <rc> — <kind>, target <cr>, baseline <cr|none>, …`. */
interface Facts {
  context: string; kind: "full" | "delta" | "unchanged"; records: number;
  target: string; baseline: string | null; covered: boolean;
}

const RC = "rc_[a-z2-7]{26}";
const CR = "cr_[a-z2-7]{26}";

/** The facts a present's reply states, or the case fails. */
function factsOf(c: Core, step: string, reply: string): Facts {
  const same = new RegExp(`^Review context: (${RC}) — no change since (${CR}) — covered\\.$`, "m").exec(reply);
  if (same) return { context: same[1], kind: "unchanged", records: 0, target: same[2], baseline: same[2], covered: true };
  const m = new RegExp(`^Review context: (${RC}) — (full|delta)(?: \\((\\d+) records?\\))?(?: \\([^)]*\\))?, ` +
                       `target (${CR}), baseline (${CR}|none), (covered|not yet covered)\\.$`, "m").exec(reply);
  if (!m) return c.fail(step, `no facts line in: ${reply.slice(0, 1500)}`);
  return { context: m[1], kind: m[2] as "full" | "delta", records: Number(m[3] ?? 0), target: m[4],
           baseline: m[5] === "none" ? null : m[5], covered: m[6] === "covered" };
}

/** A present whose facts are what the case expects: each key given must match. */
async function presented(
  c: Core, step: string, args: Record<string, unknown>, want: Partial<Facts>, via?: Mcp,
): Promise<{ reply: string; facts: Facts }> {
  const reply = await c.ok(step, "document_present", args, via);
  const facts = factsOf(c, step, reply);
  for (const [k, v] of Object.entries(want)) {
    if (facts[k as keyof Facts] !== v) c.fail(step, `${k} is ${String(facts[k as keyof Facts])}, not ${String(v)}: ${reply.slice(0, 1500)}`);
  }
  return { reply, facts };
}

/** Where a part said the next one starts — a part ends on a line boundary, so this is not the
 *  `limit` asked for. */
function nextOffset(c: Core, step: string, reply: string): number {
  const at = /^Next: offset (\d+)/m.exec(reply)?.[1];
  return at === undefined ? c.fail(step, `no Next: offset in: ${reply.slice(0, 1200)}`) : Number(at);
}

/** The content revision a read of the current document states. */
async function tokenOf(c: Core, path: string): Promise<string> {
  const read = await c.ok(`read ${path}`, "document_read", { path });
  return new RegExp(`^content_revision: (${CR})$`, "m").exec(read)?.[1] ?? c.fail(`read ${path}`, `no content_revision in: ${read}`);
}

/** Every stored row of a document, oldest first: its revision, public version and own generation. */
async function revisions(c: Core, path: string): Promise<{ revision: number; version: number; generation: string | null }[]> {
  const [initiative, name] = [path.split("/")[0], path.split("/").slice(1).join("/")];
  return (await c.sql.query<{ revision: number; version: number; generation: string | null }>(
    `select r.revision, r.version, r.content_generation::text as generation
       from zz.doc_revision r join zz.doc d on d.id = r.doc_id join zz.initiative i on i.id = d.initiative_id
      where i.slug = $1 and d.path = $2 order by r.revision`, [initiative, name])).rows;
}

/** Every presentation row recorded for a document, oldest first. */
async function shownRows(c: Core, path: string): Promise<Record<string, unknown>[]> {
  return (await c.sql.query<{ detail: Record<string, unknown> }>(
    `select e.detail from zz.event e join zz.initiative i on i.id = e.initiative_id
      where i.slug = $1 and e.subject = $2 and e.kind in ('document.shown', 'document.shown_part')
      order by e.id`, [path.split("/")[0], path])).rows.map((r) => r.detail);
}

/** The document's status, as its row records it. */
async function statusOf(c: Core, path: string): Promise<string> {
  const [initiative, name] = [path.split("/")[0], path.split("/").slice(1).join("/")];
  return (await c.sql.query<{ status: string }>(
    `select d.status from zz.doc d join zz.initiative i on i.id = d.initiative_id
      where i.slug = $1 and d.path = $2`, [initiative, name])).rows[0]?.status ?? "missing";
}

/** The snapshot `document_read(path, content_revision)` returns: its body, or the refusal. */
async function snapshotBody(c: Core, step: string, path: string, cr: string): Promise<string> {
  const read = await c.call(step, "document_read", { path, content_revision: cr });
  return read.startsWith("ERROR") ? read : documentBody(read);
}

/** Lines and characters of a block with its gap, as the change set counts an extent. */
const extent = (s: string): string =>
  `${s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0)} lines, ${s.length} characters`;

/** A section the changes never touch, long enough that every change set is shorter than the body,
 *  and kept first so no reorder moves it. */
const PAD = "## Context\n\n" + "This paragraph stays exactly as written in every snapshot of the document.\n".repeat(60);
const KEPT = "stays exactly as written";

/** r1 full → r2 complete delta → r3 compares with r2; a new context is shown everything. */
export async function advancingBaseline(c: Core): Promise<void> {
  const I = await c.open("advancing");
  const d = `${I}/plan.md`;
  await c.ok("write the plan", "document_write", { path: d, content: `# Plan\n\n${PAD}\n## Steps\n\nstep one.\n` });

  let step = "r1: a present without a context mints one and shows the whole document, covered";
  const r1 = await tokenOf(c, d);
  const { reply: full, facts: f1 } = await presented(c, step, { path: d }, { kind: "full", target: r1, baseline: null, covered: true });
  if (!full.includes(KEPT) || !full.includes("step one.")) c.fail(step, `the body was not shown whole: ${full.slice(0, 800)}`);
  const ctx = f1.context;
  c.pass(step);

  step = "r2: the next present in the context is the complete delta from r1 — covered, and r2 is its baseline";
  await c.ok(step, "document_edit", { path: d, edits: [{ find: "step one.", replace: "step one, revised." }] });
  const r2 = await tokenOf(c, d);
  const { reply: d2 } = await presented(c, step, { path: d, review_context: ctx },
                                        { context: ctx, kind: "delta", records: 1, target: r2, baseline: r1, covered: true });
  if (!d2.includes('edited "## Steps" at section 3') || !d2.includes("step one, revised.") || d2.includes(KEPT)) {
    c.fail(step, `the delta: ${d2}`);
  }
  c.pass(step);

  step = "r3 compares with r2, not r1: the delta names only what changed since r2";
  await c.ok(step, "document_edit", { path: d, content: `# Plan\n\n${PAD}\n## Steps\n\nstep one, revised.\n\n## Risks\n\nnone yet.\n` });
  const r3 = await tokenOf(c, d);
  const { reply: d3 } = await presented(c, step, { path: d, review_context: ctx },
                                        { context: ctx, kind: "delta", records: 1, target: r3, baseline: r2, covered: true });
  if (!d3.includes('added "## Risks" at section 4') || d3.includes('edited "## Steps"') || d3.includes(KEPT)) c.fail(step, `the delta: ${d3}`);
  c.pass(step);

  step = "presenting the covered snapshot again in its context: no change since it — covered";
  await presented(c, step, { path: d, review_context: ctx }, { context: ctx, kind: "unchanged", target: r3 });
  c.pass(step);

  step = "a new context gets full content, though another context covered every snapshot";
  const { facts: fresh } = await presented(c, step, { path: d }, { kind: "full", target: r3, baseline: null, covered: true });
  if (fresh.context === ctx) c.fail(step, `the new present reused ${ctx}`);
  c.pass(step);

  step = "`full: true` in a context with a covered baseline shows the whole document";
  const { reply: whole } = await presented(c, step, { path: d, review_context: ctx, full: true },
                                           { context: ctx, kind: "full", target: r3, covered: true });
  if (!whole.includes(KEPT)) c.fail(step, `not whole: ${whole.slice(0, 800)}`);
  c.pass(step);

  step = "a targeted document_read records no presentation";
  const before = (await shownRows(c, d)).length;
  await c.ok(step, "document_read", { path: d });
  await c.ok(step, "document_read", { path: d, content_revision: r1 });
  if ((await shownRows(c, d)).length !== before) c.fail(step, "a read recorded a presentation");
  c.pass(step);
}

/** Every kind of change the decision names, each in a delta of its own, presented in one context
 *  whose baseline each covered delta advances. */
export async function everyChange(c: Core): Promise<void> {
  const I = await c.open("every-change");
  const d = `${I}/doc.md`;
  const sections = (s: Record<string, string>, order: string[]): string => order.map((h) => `${h}\n\n${s[h]}\n`).join("\n");
  const s: Record<string, string> = {
    "## Context": PAD.slice("## Context\n\n".length).trimEnd(), "## Alpha": "alpha body.", "## Beta": "beta body.",
    "## Gamma": "gamma body.", "## Notes": "first notes.", "## Notes ": "second notes.", "## Gone": "gone body.",
  };
  // Two sections share one title: the second is keyed "## Notes " here and written as "## Notes".
  let order = ["## Context", "## Alpha", "## Beta", "## Gamma", "## Notes", "## Notes ", "## Gone"];
  let preamble = "Opening words before any heading.\n\n";
  const body = (): string => preamble + sections(s, order).replace("## Notes \n", "## Notes\n");
  await c.ok("write the document", "document_write", { path: d, content: body() });
  const { facts } = await presented(c, "present it whole", { path: d }, { kind: "full", covered: true });
  const ctx = facts.context;

  /** One edit to the body or the metadata, then the delta in the context: exactly `records`. */
  const delta = async (what: string, edit: Record<string, unknown>, records: string[], shows: string[] = []): Promise<void> => {
    const step = `${what}: in the delta, and the delta covered advances the baseline`;
    const was = await tokenOf(c, d);
    await c.ok(step, "document_edit", { path: d, ...edit });
    const now = await tokenOf(c, d);
    const { reply } = await presented(c, step, { path: d, review_context: ctx },
                                      { context: ctx, kind: "delta", records: records.length, target: now, baseline: was, covered: true });
    const listed = reply.slice(reply.indexOf("\n\n") + 2);
    for (const r of records) if (!listed.split("\n").includes(r)) c.fail(step, `no record \`${r}\` in: ${listed}`);
    for (const t of shows) if (!listed.includes(t)) c.fail(step, `the changed block \`${t}\` is not shown in full: ${listed}`);
    if (listed.includes(KEPT)) c.fail(step, `the untouched section was shown: ${listed.slice(0, 600)}`);
    c.pass(step);
  };

  order = [...order, "## Added"];
  s["## Added"] = "added body.";
  await delta("a new section", { content: body() }, ['added "## Added" at section 8'], ["## Added\n\nadded body."]);

  const gone = "## Gone\n\ngone body.\n\n";
  order = order.filter((h) => h !== "## Gone");
  await delta("a deleted section, with its extent", { content: body() }, [`removed "## Gone" from section 7 (${extent(gone)})`]);

  order = order.map((h) => (h === "## Beta" ? "## Bravo" : h));
  s["## Bravo"] = s["## Beta"];
  await delta("a renamed section", { content: body() }, ['renamed "## Beta" to "## Bravo" at section 3']);

  order = ["## Context", "## Bravo", "## Alpha", ...order.slice(3)];
  await delta("two sections reordered", { content: body() }, ['moved "## Bravo" from section 3 to section 2']);

  order = [...order.filter((h) => h !== "## Gamma"), "## Gamma"];
  await delta("a section moved to the end", { content: body() }, ['moved "## Gamma" from section 4 to section 7']);

  s["## Notes "] = "second notes, revised.";
  await delta("a change to the second of two sections with one title", { content: body() },
              ['edited "## Notes" at section 5'], ["## Notes\n\nsecond notes, revised."]);

  preamble = "Opening words, rewritten, before any heading.\n\n";
  await delta("the preamble", { content: body() },
              [`preamble: was ${extent("Opening words before any heading.\n\n")}; now ${extent(preamble)}`],
              ["Opening words, rewritten, before any heading."]);

  // The text between two sections: a blank line more after Alpha's body.
  s["## Alpha"] = "alpha body.\n";
  await delta("the text between two sections", { content: body() }, ['edited "## Alpha" at section 3']);

  const trailing = documentBody(await c.ok("read the tail", "document_read", { path: d })).slice(body().trimEnd().length);
  await delta("the trailing text", { content: `${body().trimEnd()}\n\n\n` },
              [`trailing text: was ${JSON.stringify(trailing)}; now ${JSON.stringify("\n\n\n")}`]);

  await delta("the review metadata — title, tags, stakeholder and a flow field",
              { title: "Reviewed", tags: ["alpha", "beta"], stakeholder: "Ana", fields: { component: "billing" } },
              ['title: was "doc"; now "Reviewed"', 'tags: was ""; now "alpha, beta"', 'stakeholder: was ""; now "Ana"',
               'fields.component: was ""; now "billing"']);
}

/** A partial presentation pins the snapshot it cut, pages of two snapshots never combine, a
 *  context resumes for its own principal, and nobody else — another principal, or the same one
 *  under another credential — can borrow it. */
export async function contextsAndPins(c: Core): Promise<void> {
  const I = await c.open("contexts");
  const body = (word: string) => `# Pinned\n\nThe ${word} line comes first.\n\n${PAD}`;

  let step = "a working row nobody was shown is rewritten in place by an edit";
  const w = `${I}/working.md`;
  await c.ok(step, "document_write", { path: w, content: body("alpha") });
  await c.ok(step, "document_edit", { path: w, edits: [{ find: "alpha", replace: "gamma" }] });
  if ((await revisions(c, w)).length !== 1) c.fail(step, `rows: ${JSON.stringify(await revisions(c, w))}`);
  c.pass(step);

  step = "a partial presentation pins its snapshot: the next edit files a new row, and the snapshot stays readable by identity";
  const shown = await tokenOf(c, w);
  const { reply: cut, facts: part } = await presented(c, step, { path: w, limit: 200 }, { kind: "full", target: shown, covered: false });
  const resume = nextOffset(c, step, cut);
  await c.ok(step, "document_edit", { path: w, edits: [{ find: "gamma", replace: "omega" }] });
  const rows = await revisions(c, w);
  if (rows.length !== 2 || rows[0].version !== rows[1].version) c.fail(step, `rows: ${JSON.stringify(rows)}`);
  const kept = await snapshotBody(c, step, w, shown);
  if (kept.trim() !== body("gamma").trim()) c.fail(step, `the presented snapshot: ${kept.slice(0, 600)}`);
  c.pass(step);

  step = "the context resumes on another session and another client of the same principal: its continuation serves the pinned snapshot and says it is no longer current";
  const now = await tokenOf(c, w);
  const { reply: rest } = await presented(c, step, { path: w, review_context: part.context, offset: resume },
                                          { context: part.context, kind: "full", target: shown, covered: true }, c.client({ client: "another-app" }));
  if (!rest.includes("no longer the current snapshot") || !rest.includes(now)) c.fail(step, rest.slice(0, 1200));
  c.pass(step);

  step = "approving in a context that covered an earlier snapshot is APPROVAL_CONFLICT, and its delta presented then approves";
  await c.refused(step, "document_approve", { path: w, review_context: part.context },
                  new RegExp(`^ERROR: APPROVAL_CONFLICT — ${esc(w)} is at content revision ${now} now, not ${shown}`));
  await presented(c, step, { path: w, review_context: part.context },
                  { context: part.context, kind: "delta", target: now, baseline: shown, covered: true }, c.client());
  const signed = await c.ok(step, "document_approve", { path: w, expected_revision: now, review_context: part.context }, c.client());
  if (!signed.includes(`Signed: content revision ${now}, as presented in review context ${part.context}.`)) c.fail(step, signed);
  c.pass(step);

  step = "pages of two snapshots of one length never combine: neither is covered, and approval is PRESENTATION_REQUIRED";
  const m = `${I}/mixed.md`;
  await c.ok(step, "document_write", { path: m, content: body("alpha") });
  const t1 = await tokenOf(c, m);
  const { reply: half, facts: first } = await presented(c, step, { path: m, limit: 300 }, { target: t1, covered: false });
  const rest2 = nextOffset(c, step, half);
  await c.ok(step, "document_edit", { path: m, edits: [{ find: "alpha", replace: "omega" }] });
  const t2 = await tokenOf(c, m);
  // The rest of the document — but of the new snapshot, which is exactly as long.
  await presented(c, step, { path: m, review_context: first.context, full: true, offset: rest2 },
                  { context: first.context, kind: "full", target: t2, covered: false });
  await c.refused(step, "document_approve", { path: m, review_context: first.context },
                  new RegExp(`^ERROR: PRESENTATION_REQUIRED — the review context ${first.context} has not covered ${t2}`));
  await c.refused(step, "document_approve", { path: m }, new RegExp(`^ERROR: PRESENTATION_REQUIRED — no review context of yours covers ${t2}`));
  if (await statusOf(c, m) === "approved") c.fail(step, "a refused approval sealed the document");
  c.pass(step);

  step = "a `version` present of the current snapshot pins it and covers nothing; one of history records nothing";
  const h = `${I}/history.md`;
  await c.ok(step, "document_write", { path: h, content: body("alpha") });
  const read = await c.ok(step, "document_present", { path: h, version: 1 });
  if (!read.includes("a read outside any review context") || /^Review context:/m.test(read)) c.fail(step, read.slice(0, 800));
  await c.refused(step, "document_approve", { path: h }, /^ERROR: PRESENTATION_REQUIRED — no review context of yours covers/);
  await c.ok(step, "document_edit", { path: h, edits: [{ find: "alpha", replace: "omega" }] });
  if ((await revisions(c, h)).length !== 2) c.fail(step, `the version present did not pin its row: ${JSON.stringify(await revisions(c, h))}`);
  await c.sign(h);
  await c.ok(step, "document_edit", { path: h, edits: [{ find: "omega", replace: "sigma" }], source_content: "Version 2 was asked for." });
  const before = (await shownRows(c, h)).length;
  const old = await c.ok(step, "document_present", { path: h, version: 1 });
  if (!old.includes("not the current one") || (await shownRows(c, h)).length !== before) c.fail(step, `history: ${old.slice(0, 800)}`);
  c.pass(step);

  await foreign(c, I, "another principal of the team", await c.member().then((email) => c.client({ email })));
  await foreign(c, I, "the same principal under another credential", c.client({ via: "pat" }));
}

/** A context presented by the seeded principal under `forwarded`, asked about by `other`: unknown
 *  to it, for presenting and for approving, and its coverage counts for nothing. */
async function foreign(c: Core, I: string, who: string, other: Mcp): Promise<void> {
  const step = `${who} cannot borrow a context: approving with it or without it is PRESENTATION_REQUIRED, and presenting with it starts a new one in full`;
  const f = `${I}/foreign-${who.split(" ").pop()}.md`;
  await c.ok(step, "document_write", { path: f, content: `# Foreign\n\n${PAD}` });
  const cr = await tokenOf(c, f);
  const { facts: own } = await presented(c, step, { path: f }, { target: cr, covered: true });
  await c.refused(step, "document_approve", { path: f, review_context: own.context, expected_revision: cr },
                  new RegExp(`^ERROR: PRESENTATION_REQUIRED — the review context ${own.context} is not one of yours`), other);
  await c.refused(step, "document_approve", { path: f }, new RegExp(`^ERROR: PRESENTATION_REQUIRED — no review context of yours covers ${cr}`), other);
  // A continuation without a context joins only the caller's own open presentation.
  await presented(c, step, { path: f, offset: 100 }, { kind: "full", target: cr, baseline: null, covered: false }, other);
  const { reply, facts } = await presented(c, step, { path: f, review_context: own.context },
                                           { kind: "full", target: cr, baseline: null, covered: true }, other);
  if (facts.context === own.context || !reply.includes(`The review context ${own.context} is not one of yours for ${f}, so a new one was started.`)) {
    c.fail(step, reply.slice(0, 800));
  }
  if (await statusOf(c, f) === "approved") c.fail(step, "a borrowed context sealed the document");
  c.pass(step);
}

/** A body long enough that a one-section change is named record by record, never "as long as the
 *  document". */
const LONG = "## Kept\n\n" + "a line no change in this group touches.\n".repeat(40);

/** The approval act rows of a document: their details. */
async function approvalActs(c: Core, path: string): Promise<Record<string, string>[]> {
  return (await c.sql.query<{ detail: Record<string, string> }>(
    `select e.detail from zz.event e join zz.initiative i on i.id = e.initiative_id
      where i.slug = $1 and e.subject = $2 and e.kind = 'document.document_approve' order by e.id`,
    [path.split("/")[0], path])).rows.map((r) => r.detail);
}

/** The approval's reply names what it signed and the context it rests on; its one act row says so too. */
async function signedAs(c: Core, step: string, path: string, reply: string, cr: string, rc: string): Promise<void> {
  if (!reply.includes(`Signed: content revision ${cr}, as presented in review context ${rc}.`)) c.fail(step, reply);
  const acts = await approvalActs(c, path);
  const last = acts[acts.length - 1];
  if (last?.content_revision !== cr || last.review_context !== rc) c.fail(step, `the approval's act rows: ${JSON.stringify(acts)}`);
  if (await statusOf(c, path) !== "approved") c.fail(step, "the approval did not seal the document");
}

/** A change after display is a conflict; two presents without a context and a paged body without one
 *  both approve on the caller's most recent covering context. */
export async function approvals(c: Core): Promise<void> {
  const A = await c.open("approvals");

  let step = "an edit after display makes approval APPROVAL_CONFLICT, naming what changed, and nothing is sealed";
  const e = `${A}/edited.md`;
  await c.ok(step, "document_write", { path: e, content: `# Edited\n\nas shown.\n\n${LONG}` });
  const { facts: f } = await presented(c, step, { path: e }, { covered: true });
  await c.ok(step, "document_edit", { path: e, edits: [{ find: "as shown.", replace: "changed after display." }] });
  const now = await tokenOf(c, e);
  const conflict = await c.refused(step, "document_approve", { path: e, expected_revision: f.target, review_context: f.context },
    new RegExp(`^ERROR: APPROVAL_CONFLICT — ${esc(e)} is at content revision ${now} now, not ${f.target}`));
  if (!conflict.includes(`changed since ${f.target}`) || !conflict.includes('edited "# Edited"')) c.fail(step, conflict);
  if (await statusOf(c, e) === "approved" || (await approvalActs(c, e)).length) c.fail(step, "a conflicting approval sealed or recorded");
  c.pass(step);

  step = "a metadata change after display makes approval APPROVAL_CONFLICT, naming the field, and nothing is sealed";
  const m = `${A}/metadata.md`;
  await c.ok(step, "document_write", { path: m, content: `# Metadata\n\n${LONG}` });
  const { facts: g } = await presented(c, step, { path: m }, { covered: true });
  await c.ok(step, "document_edit", { path: m, fields: { component: "billing" } });
  const meta = await c.refused(step, "document_approve", { path: m, expected_revision: g.target, review_context: g.context },
                               /^ERROR: APPROVAL_CONFLICT — /);
  if (!meta.includes('fields.component: was ""; now "billing"')) c.fail(step, meta);
  if (await statusOf(c, m) === "approved") c.fail(step, "a conflicting approval sealed the document");
  c.pass(step);

  step = "presenting twice without a context, then approving without one, rests on the most recent context";
  const t = `${A}/twice.md`;
  await c.ok(step, "document_write", { path: t, content: "# Twice\n\nshown twice.\n" });
  const { facts: one } = await presented(c, step, { path: t }, { covered: true });
  const { facts: two } = await presented(c, step, { path: t }, { covered: true });
  if (one.context === two.context) c.fail(step, `two presents without a context shared ${one.context}`);
  await signedAs(c, step, t, await c.ok(step, "document_approve", { path: t }), two.target, two.context);
  c.pass(step);

  step = "a body over PART_LIMIT paged with no context passed — each continuation joins the open presentation — is approved";
  const l = `${A}/long.md`;
  await c.ok(step, "document_write", { path: l, content: `# Long\n\n${"a line of a long document, presented in parts.\n".repeat(3000)}` });
  const { reply: p1, facts: open } = await presented(c, step, { path: l }, { kind: "full", covered: false });
  const next = /^Next: offset (\d+), with review_context "(rc_[a-z2-7]{26})"\./m.exec(p1);
  if (!next || next[2] !== open.context) c.fail(step, `the first part names no continuation in its context: ${p1.slice(0, 1200)}`);
  let at = Number(next![1]);
  let covered = false;
  for (let n = 0; !covered && n < 5; n++) {
    const { reply, facts } = await presented(c, step, { path: l, offset: at }, { context: open.context, target: open.target });
    covered = facts.covered;
    at = Number(/^Next: offset (\d+)/m.exec(reply)?.[1] ?? at);
  }
  if (!covered) c.fail(step, "the parts never covered the body");
  await signedAs(c, step, l, await c.ok(step, "document_approve", { path: l }), open.target, open.context);
  c.pass(step);
}

/** The four rules for a context an approval is handed, and the one for a coverage read that fails. */
export async function approvalRules(c: Core): Promise<void> {
  const R = await c.open("approval-rules");
  const member = c.client({ email: await c.member() });

  let step = "a passed context that is not the caller's is PRESENTATION_REQUIRED — never a fallback to the caller's own covering context";
  const a = `${R}/not-yours.md`;
  await c.ok(step, "document_write", { path: a, content: `# Not yours\n\n${LONG}` });
  const { facts: theirs } = await presented(c, step, { path: a }, { covered: true }, member);
  const { facts: mine } = await presented(c, step, { path: a }, { covered: true });
  await c.refused(step, "document_approve", { path: a, review_context: theirs.context },
                  new RegExp(`^ERROR: PRESENTATION_REQUIRED — the review context ${theirs.context} is not one of yours`));
  if (await statusOf(c, a) === "approved") c.fail(step, "the refused approval sealed the document");
  await signedAs(c, step, a, await c.ok(step, "document_approve", { path: a, review_context: mine.context }), mine.target, mine.context);
  c.pass(step);

  step = "a passed context that covered an earlier snapshot is APPROVAL_CONFLICT, from the snapshot it covered";
  const b = `${R}/behind.md`;
  await c.ok(step, "document_write", { path: b, content: `# Behind\n\nfirst.\n\n${LONG}` });
  const { facts: was } = await presented(c, step, { path: b }, { covered: true });
  await c.ok(step, "document_edit", { path: b, edits: [{ find: "first.", replace: "second." }] });
  const now = await tokenOf(c, b);
  const behind = await c.refused(step, "document_approve", { path: b, review_context: was.context },
    new RegExp(`^ERROR: APPROVAL_CONFLICT — ${esc(b)} is at content revision ${now} now, not ${was.target}`));
  if (!behind.includes('edited "# Behind"')) c.fail(step, behind);
  c.pass(step);

  step = "a passed context still presenting the current snapshot is PRESENTATION_REQUIRED, to finish it — not a conflict — and approves once finished";
  const { reply: cut, facts: part } = await presented(c, step, { path: b, review_context: was.context, limit: 20 },
                                          { context: was.context, kind: "delta", target: now, baseline: was.target, covered: false });
  await c.refused(step, "document_approve", { path: b, review_context: part.context },
                  new RegExp(`^ERROR: PRESENTATION_REQUIRED — the review context ${part.context} has not covered ${now}.*not complete`));
  await presented(c, step, { path: b, review_context: part.context, offset: nextOffset(c, step, cut) },
                  { context: part.context, kind: "delta", target: now, covered: true });
  await signedAs(c, step, b, await c.ok(step, "document_approve", { path: b, review_context: part.context, expected_revision: now }),
                 now, part.context);
  c.pass(step);

  step = "a coverage read that fails refuses with a plain ERROR — no code, nothing sealed — and the same approval lands once it reads";
  const f = `${R}/unreadable.md`;
  await c.ok(step, "document_write", { path: f, content: "# Unreadable\n\nbody.\n" });
  const { facts: shown } = await presented(c, step, { path: f }, { covered: true });
  // One recorded page whose span is not a number: the coverage query's cast fails on it.
  const corrupt = (to: string) => c.sql.query(
    `update zz.event e set detail = jsonb_set(e.detail, '{start}', to_jsonb($3::text))
       from zz.initiative i where i.id = e.initiative_id and i.slug = $1 and e.subject = $2
        and e.detail->>'review_context' = $4`, [R, f, to, shown.context]);
  await corrupt("not a number");
  const failed = await c.refused(step, "document_approve", { path: f },
                                 new RegExp(`^ERROR: ${esc(f)} was not approved — what was presented of it could not be read`));
  if (/PRESENTATION_REQUIRED|APPROVAL_CONFLICT/.test(failed) || await statusOf(c, f) === "approved") c.fail(step, failed);
  await c.sql.query(
    `update zz.event e set detail = jsonb_set(e.detail, '{start}', '0'::jsonb)
       from zz.initiative i where i.id = e.initiative_id and i.slug = $1 and e.subject = $2
        and e.detail->>'review_context' = $3`, [R, f, shown.context]);
  await signedAs(c, step, f, await c.ok(step, "document_approve", { path: f }), shown.target, shown.context);
  c.pass(step);
}

/** Two callers on the document's lock: the check holds it, the first queues, then the second, and
 *  both are let go together — the first commits first. */
async function raced(c: Core, step: string, path: string, a: () => Promise<string>, b: () => Promise<string>): Promise<[string, string]> {
  const key = c.docKey(path);
  await c.hold(key);
  let first: Promise<string>;
  let second: Promise<string>;
  try {
    first = a();
    await c.waiters(step, key, 1);
    second = b();
    await c.waiters(step, key, 2);
  } finally {
    await c.release(key);
  }
  return Promise.all([first, second]);
}

/** An approval and an edit, and a present and an edit, raced in both orders. */
export async function races(c: Core): Promise<void> {
  const X = await c.open("present-races");
  const other: Mcp = c.client();

  let step = "an approval reaching the lock before an edit signs the snapshot presented, and the edit is sent back";
  const a = `${X}/approve-first.md`;
  await c.ok(step, "document_write", { path: a, content: `# Race\n\nbefore.\n\n${LONG}` });
  const { facts: fa } = await presented(c, step, { path: a }, { covered: true });
  const shownBody = documentBody(await c.ok(step, "document_read", { path: a }));
  const [approved, edited] = await raced(c, step, a,
    () => c.call(step, "document_approve", { path: a, expected_revision: fa.target, review_context: fa.context }, other),
    () => c.call(step, "document_edit", { path: a, edits: [{ find: "before.", replace: "after." }] }));
  if (approved.startsWith("ERROR")) c.fail(step, `approve: ${approved}`);
  await signedAs(c, step, a, approved, fa.target, fa.context);
  if (!/^ERROR: CAUSE_REQUIRED — /.test(edited) || documentBody(await c.ok(step, "document_read", { path: a })) !== shownBody) {
    c.fail(step, `edit: ${edited}`);
  }
  c.pass(step);

  step = "an edit reaching the lock before an approval stands, and the approval is APPROVAL_CONFLICT — nothing newer is signed";
  const b = `${X}/edit-first.md`;
  await c.ok(step, "document_write", { path: b, content: `# Race\n\nbefore.\n\n${LONG}` });
  const { facts: fb } = await presented(c, step, { path: b }, { covered: true });
  const [edit, conflict] = await raced(c, step, b,
    () => c.call(step, "document_edit", { path: b, edits: [{ find: "before.", replace: "after." }] }),
    () => c.call(step, "document_approve", { path: b, expected_revision: fb.target, review_context: fb.context }, other));
  const now = await tokenOf(c, b);
  if (edit.startsWith("ERROR")) c.fail(step, `edit: ${edit}`);
  if (!conflict.startsWith(`ERROR: APPROVAL_CONFLICT — ${b} is at content revision ${now} now, not ${fb.target}`)) c.fail(step, `approve: ${conflict}`);
  if (await statusOf(c, b) === "approved" || (await approvalActs(c, b)).length) c.fail(step, "the approval sealed or recorded");
  c.pass(step);

  step = "a present reaching the lock before an edit pins the snapshot: the edit files a new row, and the presented one stays readable";
  const p = `${X}/present-first.md`;
  await c.ok(step, "document_write", { path: p, content: `# Race\n\nbefore.\n\n${LONG}` });
  const t1 = await tokenOf(c, p);
  const presentedBody = documentBody(await c.ok(step, "document_read", { path: p }));
  const [shown, after] = await raced(c, step, p,
    () => c.call(step, "document_present", { path: p }),
    () => c.call(step, "document_edit", { path: p, edits: [{ find: "before.", replace: "after." }] }, other));
  if (shown.startsWith("ERROR") || !new RegExp(`target ${t1}, baseline none, covered\\.$`, "m").test(shown)) c.fail(step, `present: ${shown}`);
  if (after.startsWith("ERROR")) c.fail(step, `edit: ${after}`);
  const rows = await revisions(c, p);
  if (rows.length !== 2 || rows[0].version !== rows[1].version) c.fail(step, `rows: ${JSON.stringify(rows)}`);
  if (await snapshotBody(c, step, p, t1) !== presentedBody) c.fail(step, `the presented snapshot: ${await snapshotBody(c, step, p, t1)}`);
  c.pass(step);

  step = "an edit reaching the lock before a present: the present says the document changed and records nothing";
  const q = `${X}/edit-before-present.md`;
  await c.ok(step, "document_write", { path: q, content: `# Race\n\nbefore.\n\n${LONG}` });
  const q1 = await tokenOf(c, q);
  const [moved, refused] = await raced(c, step, q,
    () => c.call(step, "document_edit", { path: q, edits: [{ find: "before.", replace: "after." }] }, other),
    () => c.call(step, "document_present", { path: q }));
  const q2 = await tokenOf(c, q);
  if (moved.startsWith("ERROR")) c.fail(step, `edit: ${moved}`);
  if (!refused.startsWith(`ERROR: ${q} changed while it was being presented — it is at content revision ${q2} now, not ${q1}.`)) {
    c.fail(step, `present: ${refused}`);
  }
  if ((await shownRows(c, q)).length || (await revisions(c, q)).length !== 1) c.fail(step, "the lost present recorded, or the unshown row was not rewritten in place");
  c.pass(step);
}

/** A document whose rows were written before rows carried their own generation. */
export async function legacyRows(c: Core): Promise<void> {
  const L = await c.open("legacy");
  const d = `${L}/old.md`;
  let step = "a document whose rows carry no generation: the current one reads with the document's identity, the superseded one with none";
  await c.ok(step, "document_write", { path: d, content: `# Old\n\nfirst version.\n\n${LONG}` });
  await c.sign(d);
  await c.ok(step, "document_edit", { path: d, edits: [{ find: "first version.", replace: "second version." }],
                                      source_content: "The second version was asked for." });
  // As a row written before the column existed: the setup writes only the database this check started.
  await c.sql.query(
    `update zz.doc_revision r set content_generation = null
       from zz.doc s join zz.initiative i on i.id = s.initiative_id where r.doc_id = s.id and i.slug = $1 and s.path = 'old.md'`, [L]);
  const token = await tokenOf(c, d);
  const generation = (await c.sql.query<{ g: string }>(
    `select s.content_generation::text as g from zz.doc s join zz.initiative i on i.id = s.initiative_id
      where i.slug = $1 and s.path = 'old.md'`, [L])).rows[0].g;
  const v1 = await c.ok(step, "document_read", { path: d, version: 1 });
  if (/^content_revision:/m.test(v1)) c.fail(step, `the superseded legacy row was given an identity: ${first(v1)}`);
  c.pass(step);

  step = "presented, its current row is stamped with the document's generation, its token unchanged, the superseded row left null";
  const body = documentBody(await c.ok(step, "document_read", { path: d }));
  const { facts } = await presented(c, step, { path: d }, { kind: "full", target: token, covered: true });
  const rows = await revisions(c, d);
  if (rows[rows.length - 1].generation !== generation || rows.slice(0, -1).some((r) => r.generation !== null)) {
    c.fail(step, `rows after the present: ${JSON.stringify(rows)} (the document's generation is ${generation})`);
  }
  c.pass(step);

  step = "approved on that presentation, it keeps its base token: an edit sent with it lands";
  await signedAs(c, step, d, await c.ok(step, "document_approve", { path: d, expected_revision: token, review_context: facts.context }),
                 token, facts.context);
  if (await tokenOf(c, d) !== token) c.fail(step, `the approval moved the token from ${token} to ${await tokenOf(c, d)}`);
  const edited = await c.ok(step, "document_edit", { path: d, base: token, edits: [{ find: "second version.", replace: "third version." }],
                                                     source_content: "The third version was asked for." });
  if (/BASE_CONFLICT/.test(edited)) c.fail(step, edited);
  c.pass(step);

  step = "its presented snapshot stays readable by identity after the edit";
  if (await snapshotBody(c, step, d, token) !== body) c.fail(step, `the presented snapshot: ${await snapshotBody(c, step, d, token)}`);
  c.pass(step);
}

/** A present's text and panel payload, as the client receives them: the tool's text and `_meta`. */
async function presentRaw(c: Core, step: string, args: Record<string, unknown>): Promise<{ text: string; panel: unknown }> {
  const env = await c.mcp.rpc("tools/call", { name: "document_present", arguments: args });
  if (env.error) return c.fail(step, JSON.stringify(env.error));
  const text = (env.result?.content ?? []).map((x) => x?.text ?? "").filter(Boolean).join("\n");
  if (text.startsWith("ERROR")) c.fail(step, text);
  const panel = (env.result?._meta?.["zz-core/documents"] as unknown[] | undefined)?.[0];
  if (!panel) c.fail(step, "the present drew no panel");
  return { text, panel };
}

/** A ticketless `document_shown` from an agent's credential is refused; a full and a delta present
 *  record the text they returned and the panel payload they drew, exactly. */
export async function recordsAndSizes(c: Core): Promise<void> {
  const S = await c.open("records");
  const d = `${S}/sized.md`;
  await c.ok("write the document", "document_write", { path: d, content: `# Sized\n\nfirst.\n\n${LONG}` });
  const cr = await tokenOf(c, d);

  let step = "a ticketless document_shown under the forwarded and the pat credential is refused and records nothing";
  for (const via of ["forwarded", "pat"]) {
    await c.refused(step, "document_shown", { path: d, content_revision: cr },
                    /^ERROR: document_shown records a presentation only with the ticket/, c.client({ via }));
  }
  if ((await shownRows(c, d)).length) c.fail(step, `rows: ${JSON.stringify(await shownRows(c, d))}`);
  c.pass(step);

  /** The row the present just recorded: its text and panel sizes are what the client received. */
  const sized = async (kind: string, shown: { text: string; panel: unknown }): Promise<void> => {
    const rows = await shownRows(c, d);
    const row = rows[rows.length - 1];
    const meta = Buffer.byteLength(JSON.stringify(shown.panel));
    if (row?.kind !== kind || row.text_chars !== shown.text.length || row.meta_bytes !== meta) {
      c.fail(step, `recorded ${JSON.stringify(row)}; the reply was ${shown.text.length} characters and the panel ${meta} bytes`);
    }
    const said = shown.text.slice(shown.text.indexOf("\n\n") + 2).replace(/\n$/, "");
    if (row.total !== said.length) c.fail(step, `total ${String(row.total)}, but the ${kind} text is ${said.length} characters`);
  };
  step = "a full present records text_chars and meta_bytes exactly, and its total is the body's length";
  const full = await presentRaw(c, step, { path: d });
  await sized("full", full);
  c.pass(step);

  step = "a delta present records text_chars and meta_bytes exactly, and its total is the change set's length";
  const ctx = /^Review context: (rc_[a-z2-7]{26})/m.exec(full.text)![1];
  await c.ok(step, "document_edit", { path: d, edits: [{ find: "first.", replace: "second." }] });
  const delta = await presentRaw(c, step, { path: d, review_context: ctx });
  if (!/ — delta \(1 record\)/.test(delta.text)) c.fail(step, delta.text.slice(0, 600));
  await sized("delta", delta);
  c.pass(step);
}
