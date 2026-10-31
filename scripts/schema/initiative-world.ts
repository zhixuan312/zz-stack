/**
 * An in-memory platform for the checks that drive zz-core's initiative readers with no database: one
 * initiative per slug, its documents as `zz.doc` rows, its branch facts as `zz.initiative_fact` rows and
 * its stage records as `zz.initiative_record` rows, answered by a stubbed `pg.Pool.prototype.query`.
 *
 * COUPLED: each pattern below is the text of one statement zz-core issues (initiative-status.ts,
 * guards.ts, chain.ts, initiative-record.ts). When one of them changes, the stub stops answering it and
 * every check installing this world fails, which is what keeps a stub honest.
 */
import pg from "pg";

/** One initiative. `id` defaults to "i1"; a check that writes stage records names it, because
 *  `writeStageRecord` keys on the initiative's id. `facts.closed_by` and `facts.outcome` are also read
 *  as the initiative's own close. */
export interface World {
  id?: string;
  flow: string | null;
  docs: Record<string, unknown>[];
  facts: Record<string, string>;
  records: Record<string, Record<string, string>>;
}

/** The columns a doc row carries; every other key of `fields` is the revision's own envelope payload. */
const COLUMNS = new Set(["status", "outcome", "approved_by", "approved_at", "closed_by", "title", "flow", "version"]);

let seq = 0;
/** A `zz.doc` row as the readers select it, written on `day` (YYYY-MM-DD). `body` is stored as given. */
export const docRow = (initiative: string, path: string, fields: Record<string, string>, body: string, day: string) => ({
  id: `d${++seq}`, path, initiative, flow: "", type: "",
  status: fields.status ?? "", outcome: fields.outcome ?? null,
  approved_by: fields.approved_by ?? null, approved_at: fields.approved_at ?? null,
  closed_by: fields.closed_by ?? null, updated_at: `${day}T00:00:00.000Z`,
  title: fields.title ?? path, body, tags: [],
  current_revision: Number(fields.version) || 1, approved_revision: null,
  current_version: Number(fields.version) || 1, content_generation: "0",
  fields: Object.fromEntries(Object.entries(fields).filter(([k]) => !COLUMNS.has(k))),
});

/** Points `TEAM_DB_URL` at a stub and makes every pool query answer from `world`; `openedAt` is the day
 *  each initiative was opened. */
export function installWorld(world: Map<string, World>, openedAt: string): void {
  process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";
  pg.Pool.prototype.query = (async function query(text: string, values: unknown[] = []) {
    const sql = String(text).replace(/\s+/g, " ").trim();
    const one = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });
    // The initiative-row readers take the team first and the slug second; `docRows` takes the
    // initiative first. One lookup each, so a route cannot read the wrong one.
    const bySlug = world.get(String(values[1] ?? ""));
    if (/select i\.slug, i\.flow, i\.closed_at::text/.test(sql)) {
      const names = (values[1] as string[]) ?? [];
      return one(names.filter((n) => world.has(n)).map((n) => ({
        slug: n, flow: world.get(n)!.flow, closed_at: null,
        closed_by: world.get(n)!.facts.closed_by ?? null, outcome: world.get(n)!.facts.outcome ?? null })));
    }
    if (/from zz\.initiative i join zz\.team t on t\.id = i\.team_id/.test(sql)) {
      return one(bySlug ? [{ id: bySlug.id ?? "i1", flow: bySlug.flow, opened_at: openedAt,
                             opened_by: "ada@zz.test", slug: String(values[1]) }] : []);
    }
    if (/from zz\.doc d\b/.test(sql) && /order by d\.path/.test(sql)) {
      return one(world.get(String(values[0]))?.docs ?? []);
    }
    if (/from zz\.doc d\b/.test(sql)) {
      const hit = (bySlug?.docs ?? []).filter((d) => d.path === values[2]);
      return one(hit.length ? [hit[hit.length - 1]] : []);
    }
    if (/from zz\.doc_revision r\b/.test(sql) && /where r\.doc_id = \$1::uuid/.test(sql)) {
      const d = [...world.values()].flatMap((w) => w.docs).find((x) => x.id === String(values[0]));
      return one(d ? [{ revision: 1, version: 1, content_state: "retained", title: d.title, body: d.body,
                        tags: [], content_hash: "h", fields: d.fields, revision_note: null,
                        written_by: "ada@zz.test", written_at: d.updated_at,
                        approved_by: d.approved_by, approved_at: d.approved_at }] : []);
    }
    if (/from zz\.initiative_fact f\b/.test(sql)) {
      return one(Object.entries(bySlug?.facts ?? {}).map(([fact, value]) => ({ fact, value })));
    }
    if (/from zz\.initiative_record r\b/.test(sql)) {
      return one(Object.entries(bySlug?.records ?? {}).flatMap(([stage, ids]) =>
        Object.entries(ids).map(([id_name, value]) => ({ stage, id_name, value }))));
    }
    // `writeStageRecord` keys on the initiative's ID, so the write finds its world by id.
    if (/insert into zz\.initiative_record\b/.test(sql)) {
      const target = [...world.values()].find((x) => x.id === String(values[0]));
      if (target) {
        const stage = String(values[1]);
        target.records[stage] = { ...(target.records[stage] ?? {}), [String(values[2])]: String(values[3]) };
      }
      return { rows: [], rowCount: 1 };
    }
    if (/delete from zz\.initiative_record\b/.test(sql)) {
      const target = [...world.values()].find((x) => x.id === String(values[0]));
      if (target) delete target.records[String(values[1])];
      return { rows: [], rowCount: 1 };
    }
    return one([]);
  }) as unknown as typeof pg.Pool.prototype.query;
}
