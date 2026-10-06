#!/usr/bin/env node
/**
 * checks/document-normalize.ts — Phase 2's acceptance, through a real zz-core on a throwaway
 * database: the platform does what it knows (AC-2.1, AC-2.2, AC-2.3).
 *
 *   node checks/document-normalize.ts   # needs Docker and a built tree (`npm run build`)
 *
 * What it establishes, one line per case:
 *
 *   - normalisation (`scripts/schema/normalize-cases.ts`, AC-2.1): an envelope sent in content —
 *     after blank lines, in CRLF — is separated, its title, tags, stakeholder and flow fields taken
 *     and every key the platform writes ignored, each reported; a named argument that differs is
 *     METADATA_CONFLICT naming both values, and a key no document records UNSUPPORTED_METADATA
 *     naming every one, so unknown or conflicting metadata is never lost; YAML, SQL and a thematic
 *     break are bodies, byte for byte; tags are lower-cased; a reference spelt `./`, with its own
 *     initiative or without `.md` is read canonically and one leaving the initiative refused; no
 *     normalisation manufactures a version; concurrent sources of one name are suffixed under the
 *     lock; and `document_read` → `document_edit(content: <the text read>)` is a no_change that
 *     reports every key the read rendered;
 *   - complete errors and detail pages (`scripts/schema/details-cases.ts`, AC-2.2): independent
 *     faults come back together — a malformed `sources` entry with a NO_MATCH edit; a bad tag, a
 *     reserved field and an unsupported envelope key; a named source that does not exist, even on
 *     a call that changes nothing; cause, match and normalisation lists past 16 KiB, a review ledger
 *     and a close past it, and one sentence past it alone, each answer under 16 KiB with its totals
 *     exact, what it left out counted, and its detail read back through `document_read` page by
 *     page, byte-equal to the stored row and the same after a later edit;
 *   - discovery (AC-2.3), in this process against the same database — the built `planEdit` and
 *     `saveDocument`, every statement counted by wrapping `pg`'s `Client.prototype.query`, as
 *     `checks/document-body-whole.ts` counts lookups: exactly one statement reads
 *     `zz.cause_link_epoch` per change, at 0, 1, 10 and 200 sources; changes that open a version
 *     issue the same number of statements at 1, 10 and 200 owed sources, and at 1, 10 and 200 named
 *     ones; all 200 are linked, and 200 sources filed before the epoch are not.
 *
 * The close case runs on a flow no shipped catalog declares — 250 documents a close requires — in
 * a copy of `catalog/` made for this run outside the checkout and removed after it.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found, then zz-core's last output.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import pg from "pg";

import { fixtureCatalog, independentFaults, longLists, longRefusals } from "../scripts/schema/details-cases.ts";
import { addSources, normalisationCases } from "../scripts/schema/normalize-cases.ts";
import { type Core, withThrowawayCore } from "../scripts/schema/throwaway-core.ts";

const NAME = "document-normalize";
const SCALES = [1, 10, 200];

/** The text of every statement this process sends while a list is set here. */
let counting: string[] | null = null;
const query = pg.Client.prototype.query;
pg.Client.prototype.query = function counted(this: pg.Client, ...args: unknown[]): unknown {
  if (counting) {
    const q = args[0];
    counting.push(typeof q === "string" ? q : String((q as { text?: unknown } | null)?.text ?? ""));
  }
  return (query as (...a: unknown[]) => unknown).apply(this, args);
} as unknown as typeof query;

/** Owed and named sources, counted: one change per scale, each computed and written in this
 *  process, its statements counted from the first read to the commit. */
async function discovery(c: Core): Promise<void> {
  const I = await c.open("discovery");
  const core = await c.inProcess();
  let step = "the fixtures: 211 owed sources and 200 filed before the epoch, 211 named ones and one to warm up";
  const body = "# Target\n\nold\n";
  for (const t of [...[0, ...SCALES].map((n) => `owed-${n}.md`), ...SCALES.map((n) => `named-${n}.md`), "warm.md"]) {
    await c.ok(step, "document_write", { path: `${I}/${t}`, content: body });
  }
  const sources = (kind: string, n: number, supports?: string) => Array.from({ length: n }, (_, i) =>
    ({ initiative: I, title: `${kind} ${n} ${i + 1}`, content: kind, ...(supports ? { supports: [supports] } : {}) }));
  const owed = await addSources(c, step, SCALES.flatMap((n) => sources("Owed", n, `owed-${n}.md`)));
  const old = await addSources(c, step, sources("Old", 200, "owed-200.md"));
  const named = await addSources(c, step, [...SCALES.flatMap((n) => sources("Named", n)), ...sources("Warm", 1)]);
  const { rows: [epoch] } = await c.sql.query<{ epoch: string | null }>("select epoch::text as epoch from zz.cause_link_epoch");
  if (!epoch?.epoch) c.fail(step, "the store records no cause-link epoch, so nothing is filed before it");
  // Filed a day before the epoch: the setup writes only the database this check started.
  const { rowCount } = await c.sql.query(
    `update zz.doc_revision r set written_at = $3::timestamptz - interval '1 day'
       from zz.doc s join zz.initiative i on i.id = s.initiative_id
      where r.doc_id = s.id and r.revision = s.current_revision and i.slug = $1 and s.path = any($2::text[])`,
    [I, old.map((p) => p.slice(I.length + 1)), epoch.epoch]);
  if (rowCount !== 200) c.fail(step, `${rowCount} sources were put before the epoch, not 200`);
  c.pass(step);

  /** One body change, computed and written as `document_edit` does: what it sent to the database. */
  const change = async (at: string, path: string, args: Record<string, unknown>): Promise<{ total: number; epoch: number }> => {
    const seen: string[] = [];
    counting = seen;
    try {
      const plan = await core.planEdit(core.pool, c.team, c.email, path, { path, edits: [{ find: "old", replace: "new" }], ...args });
      if ("reply" in plan) return c.fail(at, plan.reply);
      const saved = await core.saveDocument(plan.write);
      if (!("revision" in saved)) return c.fail(at, JSON.stringify(saved));
    } finally {
      counting = null;
    }
    return { total: seen.length, epoch: seen.filter((q) => q.includes("cause_link_epoch")).length };
  };
  const rel = (p: string) => p.slice(I.length + 1);
  // Once before anything is counted, so a cache filled on a first call counts against no scale.
  await change("warm up", `${I}/warm.md`, { sources: named.slice(-1).map(rel) });

  step = "one statement reads zz.cause_link_epoch per change, at 0, 1, 10 and 200 sources";
  const zero = await change(step, `${I}/owed-0.md`, {});
  const owedAt: Record<number, { total: number; epoch: number }> = {};
  const namedAt: Record<number, { total: number; epoch: number }> = {};
  let from = 0;
  for (const n of SCALES) {
    owedAt[n] = await change(step, `${I}/owed-${n}.md`, {});
    namedAt[n] = await change(step, `${I}/named-${n}.md`, { sources: named.slice(from, from + n).map(rel) });
    from += n;
  }
  const epochs = [zero, ...Object.values(owedAt), ...Object.values(namedAt)].map((x) => x.epoch);
  if (epochs.some((e) => e !== 1)) c.fail(step, `statements reading the epoch, per change: ${epochs.join(", ")}`);
  c.pass(step);

  step = "owed sources: the same statements at 1, 10 and 200, all 200 linked by the platform, none of the 200 filed before the epoch";
  if (new Set(SCALES.map((n) => owedAt[n].total)).size !== 1) {
    c.fail(step, `statements at ${SCALES.map((n) => `${n}: ${owedAt[n].total}`).join(", ")}`);
  }
  from = 0;
  for (const n of SCALES) {
    const cited = await c.cites(`${I}/owed-${n}.md`);
    const want = owed.slice(from, from + n).map((p) => `${p} platform v2`);
    from += n;
    if (cited.length !== n || !want.every((w) => cited.includes(w))) c.fail(step, `owed-${n}.md cites ${cited.length}: ${cited.slice(0, 3).join(" | ")}…`);
  }
  const linkedOld = (await c.cites(`${I}/owed-200.md`)).filter((x) => old.some((p) => x.startsWith(`${p} `)));
  if (linkedOld.length) c.fail(step, `${linkedOld.length} sources filed before the epoch were linked`);
  c.pass(`${step} (${owedAt[1].total} statements each)`);

  step = "named sources: the same statements at 1, 10 and 200, all 200 linked as the agent's";
  if (new Set(SCALES.map((n) => namedAt[n].total)).size !== 1) {
    c.fail(step, `statements at ${SCALES.map((n) => `${n}: ${namedAt[n].total}`).join(", ")}`);
  }
  from = 0;
  for (const n of SCALES) {
    const cited = await c.cites(`${I}/named-${n}.md`);
    const want = named.slice(from, from + n).map((p) => `${p} agent v2`);
    from += n;
    if (cited.length !== n || !want.every((w) => cited.includes(w))) c.fail(step, `named-${n}.md cites ${cited.length}: ${cited.slice(0, 3).join(" | ")}…`);
  }
  c.pass(`${step} (${namedAt[1].total} statements each)`);
}

const catalog = fixtureCatalog();
try {
  process.exitCode = await withThrowawayCore(NAME,
    `${NAME}: input read one way is normalised and reported, every independent fault said at once, long lists counted and paged whole, and owed sources found in one statement: ok`,
    async (c) => {
      await normalisationCases(c);
      await independentFaults(c);
      await longLists(c);
      await longRefusals(c);
      await discovery(c);
    }, { catalog: catalog.dir });
} finally {
  pg.Client.prototype.query = query;
  catalog.remove();
}
