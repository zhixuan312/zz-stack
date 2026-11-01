#!/usr/bin/env node
/**
 * checks/knowledge-search-neighbour-team.ts — `knowledge_search`'s citation lane reaches a
 * document through the initiative a hit belongs to or cites, by that initiative's id, never by
 * its slug: a slug is team-scoped, and the platform's shelf can hold an initiative of the same
 * name as the caller's.
 *
 *   node checks/knowledge-search-neighbour-team.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), seeds the
 * platform's team with a member, and has the seeded team and the platform's each open an
 * initiative of the same slug — so of the same dated name — and write a document into it. Only
 * the seeded team's holds the word asked for. What it establishes:
 *
 *   - the seeded team's caller asking that word is answered its own document, and nothing from
 *     the platform's initiative of the same name (second read, rs14-6: the lane's document arm
 *     matched initiative slugs across both shelves, and answered the platform's document through
 *     the evidence lane).
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "knowledge-search-neighbour-team";
const DONE = "knowledge-search-neighbour-team: the citation lane reaches no document of the platform's initiative " +
  "that shares a name with the caller's: ok";

/** COUPLED: KNOWLEDGE_TEAM in services/zz-core/src/paths.ts. */
const PLATFORM = "zz-platform";
const KEEPER = "keeper@example.test";
const WORD = "quokkaledger";
const SECRET = "PLATFORM-SHELF-ONLY";

type Row = { initiative: string; path: string; shelf: string; via: string[] };

async function run(c: Core): Promise<void> {
  let step = "the platform's team and its member";
  await c.sql.query(
    `with p as (insert into zz.principal (email, display_name, role) values ($1, 'Keeper', 'member') returning id),
          t as (insert into zz.team (slug, name, created_by)
                select $2, 'The platform', p.id from p where not exists (select 1 from zz.team where slug = $2)
                returning id),
          team as (select id from t union all select id from zz.team where slug = $2)
     insert into zz.membership (team_id, principal_id, role, added_by) select team.id, p.id, 'admin', p.id from team, p`,
    [KEEPER, PLATFORM]);
  await c.sql.query("update zz.principal set active_team_id = (select id from zz.team where slug = $2) where email = $1",
    [KEEPER, PLATFORM]);
  const keeper = c.client({ email: KEEPER });
  c.pass(step);

  step = "one initiative name on both shelves";
  const opened = async (via?: ReturnType<Core["client"]>): Promise<string> =>
    (JSON.parse(await c.ok(step, "initiative_open", { slug: "same-name" }, via)) as { initiative: string }).initiative;
  const mine = await opened();
  const theirs = await opened(keeper);
  if (mine !== theirs) c.fail(step, `the two teams opened ${mine} and ${theirs}, not one name`);
  await c.ok(step, "document_write", { path: `${mine}/notes.md`,
    content: `---\ntitle: Notes\n---\n\n# Notes\n\nThe ${WORD} settles weekly.\n` });
  await c.ok(step, "document_write", { path: `${theirs}/notes.md`,
    content: `---\ntitle: Notes\n---\n\n# Notes\n\n${SECRET}: nothing about the question.\n` }, keeper);
  c.pass(`${step}: ${mine}`);

  step = "the caller's search reaches nothing of the platform's initiative of that name";
  const raw = await c.ok(step, "knowledge_search", { query: WORD });
  const results = (JSON.parse(raw) as { results: Row[] }).results;
  const got = results.map((r) => `${r.shelf}:${r.initiative}/${r.path} via ${r.via.join("+")}`);
  if (!results.some((r) => r.shelf === "team" && r.initiative === mine && r.path === "notes.md")) {
    c.fail(step, `the caller's own document was not answered: ${got.join(", ")}`);
  }
  if (results.some((r) => r.shelf === "platform") || raw.includes(SECRET)) {
    c.fail(step, `the platform's document was answered: ${got.join(", ")}`);
  }
  c.pass(`${step}: ${got.join(", ")}`);
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
