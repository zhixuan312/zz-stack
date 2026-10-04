/**
 * Reading the knowledge shelves: `knowledge_search`. `knowledge.ts` mints a node; this file
 * queries what was minted, across both shelves the caller can reach.
 *
 * The shelf a result came from travels with it: a node on the platform shelf is opened with
 * `scope: "platform"` and a node on the team's without it, so a result that does not say which
 * sends a reader to `document_read` with the wrong argument.
 *
 * This handler reads `zz.doc`/`zz.knowledge_node` directly. The `zz.search_*` projections and the
 * tenant-info retrieval stack that was to replace them are both gone: there is one query path, and
 * this is it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller, recallResultFrom, type RecallResult } from "@zz/contracts";
import { READS, requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { type KbRow, platformEvent } from "../indexing.js";
import { KNOWLEDGE_TEAM } from "../paths.js";
import { db, teamFor } from "../platform-db.js";

/** The subject kinds a journal tag may name. COUPLED: imported from the write side, so a kind
 *  added there is searchable here without anybody remembering this file. */
import { SUBJECT_KINDS } from "./knowledge.js";

/** A row of the union below: `KbRow` is the shape the answer is built from, plus the three
 *  columns the citation graph is matched on. `subject` tells the two subjects apart, and the
 *  two id arrays are what the neighbour lane joins on — a node's citations are rows keyed by
 *  an initiative id, a document's are slugs, and neither is guessed at from the other. */
interface SearchRow extends KbRow {
  subject: string;
  initiative_id: string | null;
  cited_ids: string[] | null;
}

/** What an empty answer concludes, and the signals it concludes from. That file decides which
 *  kind of empty an empty answer is; this one produces its inputs. */
import { recallOutcomeFrom, type RecallSignals } from "./knowledge-search-verdict.js";
/** The query-to-WHERE-clause half, split out by subject — see that file's header. */
import { HAN_SCALAR_RE, HAN_SQL_CLASS, LATIN_SQL_CLASS, QUERY_CONFIG, SIMPLE_QUERY_CONFIG, buildSearchPredicate,
         type SearchPredicate } from "./search-predicate.js";


/** How much of a body `ts_headline` is given to look in, in characters.
 *
 *  DELIBERATE: a bound, and it is the difference between a working search and an unusable one.
 *  `ts_headline` re-parses the text and hunts fragments in it, and its cost is superlinear in
 *  the document — measured on this deployment's own bodies, one 1.1 MB plan took **33 s** to
 *  excerpt, while the same document truncated to 20 000 characters took 7.6 ms. The pool is up
 *  to 200 matching rows and the corpus holds 123 revisions over 300 kB, so the excerpt alone
 *  was the whole of a search's latency, and its tail: prod p90 1.1 s, max 11.5 s.
 *
 *  What this costs is marking deeper than the bound. Below it — every knowledge node on the
 *  shelf (largest 17 kB) and 1,710 of the 2,678 revisions — nothing changes at all. Above it
 *  the excerpt is drawn from the head of the document, which for markdown is the title and the
 *  summary, and matches inside that window are still marked exactly as they were. */
const HEADLINE_BYTES = 20_000;

/** Marks a document's matched terms in markdown rather than ts_headline's default <b>: the rest
 *  of this corpus is markdown, and a model reading HTML tags in a snippet treats them as content.
 *
 *  COUPLED: `QUERY_CONFIG`, so the document is parsed the way the row's Latin half was stored.
 *  A Han clause cannot come through here — see `scoringOf` — so the excerpt of a row found only
 *  by one is the head of its text, which is what `left(body, 400)` gives.
 *
 *  The query is passed as an expression, not as `rankExpr`: this runs in a statement of its own,
 *  where the predicate's parameter numbering does not exist. */
function headlineOf(column: string, queryExpr: string): string {
  return `ts_headline(${QUERY_CONFIG}, left(${column}, ${HEADLINE_BYTES}), ${queryExpr},
                 'MaxFragments=2, MaxWords=28, MinWords=12, FragmentDelimiter=" … ",
                  StartSel=**, StopSel=**')`;
}

/** The `rank` column one attempt selects by, and the parameters it must bind — the attempt's
 *  own, plus one for a Han lane's lexemes when that is the lane that scores it.
 *
 *  `rankExpr` is the ASCII lane's `websearch_to_tsquery` call, and an attempt that has one is
 *  scored exactly as it was before this lane existed.
 *
 *  A Han clause has none, and cannot have one: PostgreSQL's parser decides an unspaced Han run's
 *  token boundary before any dictionary runs, so a Han clause handed to the ASCII lane's
 *  `websearch_to_tsquery` call is one token that matches nothing the analyzer stored. Such a
 *  clause is MATCHED as a literal `body` substring — which is what the `gin (body gin_trgm_ops)`
 *  index serves — and scored here through the half of `body_tsv` the analyzer wrote it into: every
 *  Han unigram this attempt analysed, ANDed, through `SIMPLE_QUERY_CONFIG`, whose identity
 *  dictionary leaves a stored unigram equal to the term the query sends. Without it a Han-only
 *  query ties at zero, which is what every Han-only match did before this lane existed.
 *
 *  DELIBERATE: the rank does not span both halves. An attempt that has an ASCII clause keeps the
 *  rank it has always had, and a Han clause beside it adds nothing to it — this lane reaches
 *  exactly the queries that had no rank to lose.
 *
 *  DELIBERATE: no excerpt here, in any lane. `ts_headline` is the most expensive thing this
 *  handler does and the ranking pool is two hundred rows deep, while `want` — fifteen by
 *  default — is what comes back; the excerpt of each returned row is read once, below, from the
 *  rows that survive the fusion. Ranking reads no body at all: `ts_rank_cd` works on `body_tsv`.
 *
 *  Exported, and pure, so a gate check can run it without a database: a rank column is not a
 *  WHERE clause, so `buildSearchPredicate` cannot show this half of the config agreement. */
export function scoringOf(attempt: SearchPredicate): { sql: string; args: unknown[] } {
  const args: unknown[] = [...attempt.args];
  if (attempt.rankExpr) {
    return { args, sql: `ts_rank_cd(body_tsv, ${attempt.rankExpr}) as rank` };
  }
  if (attempt.hanTerms.length) {
    // The lexeme string is bound, numbered past the attempt's own parameters, so the statement's
    // numbering is still 1..n with none skipped — PostgreSQL refuses to parse one that skips.
    args.push(attempt.hanTerms.join(" & "));
    const query = `to_tsquery(${SIMPLE_QUERY_CONFIG}, $${args.length})`;
    return { args, sql: `ts_rank_cd(body_tsv, ${query}) as rank` };
  }
  return { args, sql: "0::float4 as rank" };
}



export function registerKnowledgeSearch(server: McpServer): void {
  server.registerTool(
    "knowledge_search",
    {
      annotations: READS,
      description:
        "Search your team's knowledge base and get ANSWERS, not just a list of paths. Ranks by " +
        "relevance — fusing full-text match, tag overlap, and the initiatives a node cites as " +
        "evidence — and returns a matched excerpt from each result, so a caller can cite it " +
        "without opening it. Superseded nodes are surfaced and labelled rather than hidden: " +
        "'we tried this and moved on' is usually the most valuable thing here. Envelope filters " +
        "narrow the pool; provenance (status, approvals, outcome, path) comes back on every row.",
      inputSchema: {
        query: z.string().optional().describe("What you want to know. Natural language; supports quoted phrases and -exclusions."),
        type: z.string().optional().describe("decision|design|behavior|process|knowledge|style, or a document type."),
        status: z.string().optional(), initiative: z.string().optional(),
        flow: z.string().optional().describe("Restrict to one flow's documents, e.g. 'ops-flow'."),
        tags: z.array(z.string()).optional().describe("Require at least one of these tags."),
        include_superseded: z.boolean().optional().describe("Default true — a superseded decision is usually the point. Set false for current state only."),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, type, status, initiative, flow, tags, include_superseded, limit }) => {
      const who = parseCaller(requestHeaders());
      const team = await teamFor(who.email);
      if (!team) return text("ERROR: you are not in a team — the knowledge base is team-scoped");
      const p = db();
      if (!p) return text("ERROR: knowledge index unavailable (no platform db)");

      const want = limit ?? 15;
      const withHistory = include_superseded !== false;

      /* The pool is candidate-bounded, not corpus-bounded: the row count a query materialises
       * grows with how many documents could plausibly matter, not with the knowledge base.
       * Ordered by ts_rank_cd — cover density — over the A/B/C weighting `buildRowVector`
       * (packages/indexing) applies when it builds the vector this ranks. */
      // Used by the tag and neighbour lanes below, which each build their own `cond`/`args`
      // around it. The query lane does not: `buildSearchPredicate` carries team scope and every
      // one of these filters itself.
      const applyFilters = (push: (sql: string) => void, add: (v: unknown) => string) => {
        if (type) push(`type = ${add(type)}`);
        if (status) push(`status = ${add(status)}`);
        if (initiative) push(`initiative = ${add(initiative)}`);
        if (flow) push(`flow = ${add(flow)}`);
        // Lowercased because the stored side is. A caller who filters `plugin:Sdlc` against
        // lowercase-stored tags otherwise gets an empty result that reads as "nothing is known".
        if (tags?.length) push(`tags && ${add(tags.map((t) => t.trim().toLowerCase()))}::text[]`);
        // "Replaced" is recorded in two places and a current-state filter reads both:
        // `status = 'superseded'` is the journal node's convention, set by knowledge_supersede,
        // and `superseded_by` is the successor a node names — a document has none, so its own
        // status is the whole of the answer for it.
        if (!withHistory) push(`superseded_by is null and status <> 'superseded'`);
      };

      // `team_slug` is selected because the query spans two shelves and a caller reads a path
      // back with `document_read`, which is scoped to their own team. A row that does not carry
      // its shelf answers "does not exist" for a node sitting on the platform's. It is a
      // derived column on the node side — the shelf is `team_id` there, joined back to the
      // slug a caller reads.
      //
      // `initiative_id` and `cited_ids` are the citation graph in keys: a document's own
      // initiative row, and the initiative ids its citations name. The neighbour lane below
      // matches on them, because a slug is team-scoped and two teams can each carry one.
      const COLS = `initiative, path, flow, type, status, outcome, approved_by, approved_at,
                    updated_at, title, tags, evidence, superseded_by, team_slug, subject,
                    initiative_id, cited_ids`;
      /* The two subjects, unioned here and nowhere else. A team's documents and the platform's
       * journal are separate tables because their lifecycles are: a document is `approved` when
       * a person agreed, a node is `adopted` until something better replaces it. Each side maps
       * its own vocabulary into the shared shape here, once. `subject` travels with the row so
       * a reader can tell them apart without inferring it from the path. A node has no flow,
       * outcome or approval, so those are constants on that side.
       *
       * `flow`/`outcome` on the document arm come from `zz.initiative`, not `zz.doc`: both are
       * the initiative's own — `zz.doc.flow` was only ever the same flow copied onto every one
       * of its documents, and `zz.doc.outcome` is the initiative's outcome stamped on the one
       * document that closed it, never a property of that document alone. Reading `zz.doc`
       * returned it on that one row and `null` on every sibling; the anchor answers it for all
       * of them alike. Joined through zz.doc.initiative_id, which is NOT NULL and set by every
       * insert path from the same team and slug — the key the document is filed under, rather than
       * two slugs read back and matched again. The note that stood here said the opposite, and
       * described a column a lazy reconcile pass filled: that pass, and the column it wrote, went
       * with the file store.
       *
       * The node arm is its own literal, and the union's column names come from the document
       * arm, which is why it aliases none of them. Every column it renames for the node is
       * DERIVED from the keys the reshape left: the shelf through `team_id`, the address from
       * the ordinal and the slug the file's name carries, the successor from `superseded_by_id`,
       * the citations from `knowledge_node_evidence`. */
      const NODE_ARM = `(
        select '_knowledge', 'nodes/' || k.node_ordinal || '-' || k.slug || '.md', '', k.kind,
               k.lifecycle, null, null, null::date, k.updated_at, k.title, k.tags,
               -- The citations, spelled back as the team-scoped slugs a caller reads and filters
               -- by. The relation names an initiative, so this is the one place the two are
               -- reconciled — and the ids travel beside them, which is what the neighbour lane
               -- matches on.
               (select coalesce(array_agg(i.slug order by i.slug), '{}')
                  from zz.knowledge_node_evidence ne
                  join zz.initiative i on i.id = ne.initiative_id
                 where ne.node_id = k.id),
               -- The successor as the ordinal the shelf records, which is what a reader is sent
               -- to; the key the row holds is the successor's id.
               (select s.node_ordinal from zz.knowledge_node s where s.id = k.superseded_by_id),
               t.slug, k.body, k.body_tsv, 'node', null,
               (select coalesce(array_agg(ne.initiative_id), '{}')
                  from zz.knowledge_node_evidence ne
                 where ne.node_id = k.id)
          from zz.knowledge_node k
          join zz.team t on t.id = k.team_id)`;
      const SOURCE = `(
        select i.slug as initiative, d.path, coalesce(i.flow,'') as flow, d.type, d.status,
               i.outcome, a.email as approved_by, r.approved_at, d.updated_at, d.title, d.tags,
               -- The initiative slugs this revision's citations point at, as the array the union's
               -- other arm produces. DELIBERATE: read from the cites links, not from
               -- r.fields->>'evidence' — that key belonged to the retired doc.evidence column and
               -- no writer sets it, so the neighbour lane's document arm never fired and no returned
               -- row ever carried a citation. The comment above always said a document's citations
               -- are the links beside it; this is what reads them.
               coalesce((select array_agg(distinct ti.slug order by ti.slug)
                           from zz.doc_link l
                           join zz.doc td on td.id = l.to_doc_id
                           join zz.initiative ti on ti.id = td.initiative_id
                          where l.from_doc_id = d.id and l.from_revision = r.revision
                            and l.kind = 'cites'), '{}'::text[]) as evidence,
               -- A document has no successor pointer: a later revision of it is a doc_revision
               -- row, and a document replaced by another one is status: superseded. The node
               -- arm is the one that still names one.
               null::text as superseded_by,
               t.slug as team_slug, coalesce(r.body, d.body) as body, d.body_tsv,
               'document' as subject,
               -- The union's column names come from this arm, so the two the node arm derives are
               -- named here: a bare i.id would arrive as id and a bare empty-array literal as
               -- ?column?, and the lanes below join on these two by name.
               i.id as initiative_id, '{}'::uuid[] as cited_ids
          from zz.doc d
          left join zz.initiative i on i.id = d.initiative_id
          left join zz.team t on t.id = i.team_id
          left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
          left join zz.principal a on a.id = r.approved_by
        union all
        ${NODE_ARM}
      ) k`;
      /* The query itself, through `buildSearchPredicate`: the platform's query grammar reads
       * quotes, exclusions and an explicit `OR` on the raw text, and `zz-lexical-v2` analyses
       * each clause. A Han clause matches as a literal `body` substring, because
       * `websearch_to_tsquery(QUERY_CONFIG, …)` cannot see inside an unspaced Han run. */
      const primary = buildSearchPredicate({
        query, team, type, status, initiative, flow, tags,
        includeSuperseded: withHistory ? undefined : false,
      });
      // The character class covers CJK Unified Ideographs and Extension A alongside `[a-z0-9]`,
      // so a Chinese query is visible to the tag and neighbour lanes below.
      // DELIBERATE: never ':'. That is what keeps the SUBJECT_KINDS expansion two blocks down
      // live rather than dead code.
      // COUPLED: scripts/gate/checks/documents-schema.ts reads this exact character class.
      const tokens = (query ?? "").toLowerCase().split(/[^a-z0-9\p{Script=Han}]+/u).filter(Boolean);

      const CANDIDATE_CAP = 200;
      // The attempt that produced the lexical list, and its scoring columns: the excerpt of a
      // lexical hit is marked with this one's query text, so both have to travel together.
      let active: SearchPredicate = primary;
      let scoring = scoringOf(active);
      const sql = `select ${COLS}, ${scoring.sql}
                   from ${SOURCE} where ${primary.sql}
                   order by ${query ? "rank desc, updated_at desc" : "updated_at desc"}
                   limit ${CANDIDATE_CAP}`;
      let lexical = (await p.query(sql, scoring.args)).rows as SearchRow[];

      /* Nothing came back, so ask the same question with OR before answering "nothing is known".
       * `websearch_to_tsquery` joins unquoted terms with AND, so a long question requires one
       * document containing every word.
       *
       * DELIBERATE: only where the answer was otherwise empty. A broadened pool is still ranked
       * by ts_rank_cd and still fused with the tag and evidence lanes. Every row from one
       * carries `via: ["lexical-broad"]` and the response says so.
       *
       * Only eligible unquoted positive clauses relax. `buildSearchPredicate({ …, broadened:
       * true })` turns their conjunction into a disjunction and reports whether anything was
       * eligible (`wide.broadened`). A quoted phrase, an exclusion, an explicit `OR` and every
       * scope or filter predicate never are, so a query built entirely from those reports
       * `broadened: false` and this retry is skipped. */
      let broadened = false;
      if (query && lexical.length === 0) {
        const wide = buildSearchPredicate({
          query, team, type, status, initiative, flow, tags,
          includeSuperseded: withHistory ? undefined : false, broadened: true,
        });
        if (wide.broadened) {
          active = wide;
          scoring = scoringOf(active);
          lexical = (await p.query(
            `select ${COLS}, ${scoring.sql}
               from ${SOURCE} where ${wide.sql}
              order by rank desc, updated_at desc
              limit ${CANDIDATE_CAP}`, scoring.args)).rows as SearchRow[];
          broadened = lexical.length > 0;
        }
      }

      /* Tag retrieval is its own ranked list, not a re-ranking of the lexical one. Computed from
       * the lexical hits it could only reorder what full-text found, never surface one it missed:
       * a node tagged `booking` need not contain the word someone typed. */
      let tagged: KbRow[] = [];
      if (tokens.length) {
        // Subject tags are reachable from the word they are about. `tokens` is
        // `buildSearchPredicate`'s `zz-lexical-v2` base terms, so a node tagged `plugin:sdlc`
        // is matched by neither `tags && tokens` — the stored tag is one string with a colon in
        // it — nor the lexical arm unless the body spells it.
        //
        // DELIBERATE: expanded on the query side, not the stored side, so a compound candidate
        // is only ever a tag somebody wrote and `&&` and the overlap count keep working
        // unchanged. SUBJECT_KINDS is short, so the list stays small.
        const wanted = [...new Set(tokens.flatMap((t) => [t, ...SUBJECT_KINDS.map((k) => `${k}:${t}`)]))];
        const tArgs: unknown[] = [[team, KNOWLEDGE_TEAM], wanted];
        const tPut = (v: unknown) => { tArgs.push(v); return `$${tArgs.length}`; };
        const tCond = ["team_slug = any($1::text[])", "tags && $2::text[]"];
        applyFilters((c) => tCond.push(c), tPut);
        tagged = (await p.query(
          `select ${COLS}, 0::float4 as rank
           from ${SOURCE} where ${tCond.join(" and ")}
           order by cardinality(array(select unnest(tags) intersect select unnest($2::text[]))) desc,
                    updated_at desc
           limit 50`, tArgs)).rows as SearchRow[];
      }

      /* Expand to graph neighbours of the top hits. A node's citations are rows in
       * `knowledge_node_evidence` — the initiatives it was learned from, keyed by initiative id
       * — so a node citing the same initiative as a strong hit is about the same work even when
       * it shares no vocabulary. The lane matches on those ids rather than on the slugs they
       * spell: a slug is team-scoped, and two teams can each carry one. A document still cites
       * its evidence as text this phase does not reshape, so the lane carries both keys and
       * reads each subject by the one its citations are stored in. Bounded by (seeds x their
       * citations), fetched in one targeted query — never a scan. */
      const seen = new Set([...lexical, ...tagged].map((r) => `${r.initiative}/${r.path}`));
      // Seeds come from both retrieved lists: a node found only by its tags is as good a
      // starting point for the citation graph as one found by its words. Re-read as `SearchRow`
      // here and not in the lists above: the three extra columns are what this lane joins on and
      // nothing else reads them.
      const seeds = [...lexical.slice(0, 10), ...tagged.slice(0, 10)] as SearchRow[];
      const seedIds = [...new Set(seeds.flatMap((r) =>
        [...(r.cited_ids ?? []), ...(r.initiative_id ? [r.initiative_id] : [])]))];
      const seedSlugs = [...new Set(seeds.filter((r) => r.subject === "document")
        .flatMap((r) => [...(r.evidence ?? []), r.initiative]))];
      let neighbours: SearchRow[] = [];
      if (query && (seedIds.length || seedSlugs.length)) {
        const nArgs: unknown[] = [[team, KNOWLEDGE_TEAM], seedIds, seedSlugs];
        const nPut = (v: unknown) => { nArgs.push(v); return `$${nArgs.length}`; };
        const nCond = ["team_slug = any($1::text[])",
          "(initiative_id = any($2::uuid[]) or cited_ids && $2::uuid[]" +
          " or (subject = 'document' and (initiative = any($3::text[]) or evidence && $3::text[])))"];
        applyFilters((c) => nCond.push(c), nPut);
        neighbours = ((await p.query(
          `select ${COLS}, 0::float4 as rank
           from ${SOURCE} where ${nCond.join(" and ")} order by updated_at desc limit 50`, nArgs,
        )).rows as SearchRow[]).filter((r) => !seen.has(`${r.initiative}/${r.path}`));
      }

      /* Reciprocal rank fusion over three ranked lists, k=60. The three signals are not on a
       * common scale — ts_rank_cd is a float, tag overlap a count, neighbour proximity a
       * boolean — so positions are fused rather than scores. */
      const RRF_K = 60;
      const key = (r: KbRow) => `${r.initiative}/${r.path}`;
      const fused = new Map<string, { row: KbRow; score: number; via: Set<string> }>();
      const fuse = (list: KbRow[], via: string) => list.forEach((row, i) => {
        const k = key(row);
        const e = fused.get(k) ?? { row, score: 0, via: new Set<string>() };
        e.score += 1 / (RRF_K + i + 1); e.via.add(via); fused.set(k, e);
      });

      fuse(lexical, broadened ? "lexical-broad" : "lexical");
      fuse(tagged, "tag");
      fuse(neighbours, "evidence");

      const ranked = [...fused.values()].sort((a, b) => b.score - a.score);

      /* The excerpts, read for the rows that come back rather than for the pool that was ranked.
       *
       * `ts_headline` is the most expensive thing this handler does — it re-parses a document
       * and hunts fragments in it — and it was being run over the whole two-hundred-row pool to
       * return fifteen rows. Measured against this deployment's own corpus, the excerpt was the
       * entire latency of a search and its tail (prod p90 1.1 s, max 11.5 s).
       *
       * DELIBERATE: the lane a row came from still decides how its text is cut. A row the
       * lexical pass found is marked with that pass's own query; the broadened pass has a query
       * of its own and is the only one that runs when it runs. A row found ONLY by its tags or
       * by the citation graph need not contain the query at all, so marking it would mark
       * nothing — it gets the head of its text, which is what it has always had.
       *
       * The rows read are `ranked.slice(0, want + 1)`: the fill loop below pushes on each
       * iteration or breaks, so it cannot reach past the row after its last.
       *
       * One statement for all of them, addressed by the (initiative, path) every row is returned
       * under — one read of a body however many lanes found it. `body` is not selected by any
       * lane, so this is also the only place a ranked row's text is materialised at all. */
      const snippets = new Map<string, string>();
      const shortlist = ranked.slice(0, want + 1);
      if (shortlist.length) {
        const xArgs: unknown[] = [];
        const xPut = (v: unknown): string => { xArgs.push(v); return `$${xArgs.length}`; };
        // Its own numbering, starting at 1: the predicate is not run in this statement, so
        // reusing `scoring.args` would name parameters nothing here references.
        const xQuery = active.asciiText === null
          ? null
          : xPut(active.asciiText);
        const marks = xPut(shortlist.map(({ via }) =>
          xQuery !== null && (via.has("lexical") || via.has("lexical-broad"))));
        const inits = xPut(shortlist.map(({ row }) => row.initiative));
        const paths = xPut(shortlist.map(({ row }) => row.path));
        const column = (c: string) => (xQuery === null
          ? `left(${c}, 400)`
          : `case when w.mark then ${headlineOf(c, `websearch_to_tsquery(${QUERY_CONFIG}, ${xQuery})`)}
                   else left(${c}, 400) end`);
        // `SOURCE` carries its own `k` alias — every lane reads `from ${SOURCE} where …` and calls
        // its columns `k.…` — so this names it without adding another.
        const { rows: excerpted } = await p.query<{ initiative: string; path: string; snippet: string | null }>(
          `select k.initiative, k.path, ${column("k.body")} as snippet
             from ${SOURCE}
             join unnest(${inits}::text[], ${paths}::text[], ${marks}::bool[])
               as w(initiative, path, mark)
               on w.initiative = k.initiative and w.path = k.path`, xArgs);
        for (const r of excerpted) snippets.set(`${r.initiative}/${r.path}`, r.snippet ?? "");
      }

      /* Fill a byte budget best-first rather than truncating at `limit` blindly: reporting what
       * was withheld is what stops a trimmed set being read as the complete match. */
      const BUDGET = 24_000;
      const results: unknown[] = [];
      let spent = 0;
      for (const { row, score, via } of ranked) {
        if (results.length >= want) break;
        const snippet = (snippets.get(key(row)) ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
        const size = snippet.length + row.path.length + (row.title?.length ?? 0) + 120;
        if (spent + size > BUDGET && results.length > 0) break;
        spent += size;
        results.push({
          initiative: row.initiative, path: row.path, title: row.title, type: row.type,
          // Which shelf, and therefore how to read it back. `platform` rows live in the
          // journal every team shares; document_read reaches them with scope: "platform".
          shelf: row.team_slug === team ? "team" : "platform",
          status: row.status, superseded_by: row.superseded_by ?? null,
          tags: row.tags ?? [], evidence: row.evidence ?? [], flow: row.flow,
          outcome: row.outcome, approved_by: row.approved_by, approved_at: row.approved_at,
          updated_at: row.updated_at,
          snippet,
          score: Number(score.toFixed(5)),
          via: [...via].sort(),
        });
      }

      // Both signals, because the two sides of the union say it two ways: a node carries
      // `lifecycle: superseded`, mapped to `status` in the union above, and a document keeps
      // `status: approved` and points at its successor with `superseded_by`.
      // COUPLED: `buildSearchPredicate` excludes a superseded row on the same two signals.
      const isSuperseded = (r: unknown): boolean => {
        const row = r as { status?: string | null; superseded_by?: string | null };
        return row.status === "superseded" || Boolean(row.superseded_by);
      };
      const superseded = results.filter(isSuperseded).length;

      /* An empty answer says which kind of empty it is — see knowledge-search-verdict.ts.
       *
       * Runs only when nothing came back, so no answer with results is changed by it. `results`
       * is empty exactly when `ranked` is: the fill loop stops early only once it has put
       * something in.
       *
       * The probe runs in the same scope the search did — both shelves and every filter,
       * through `applyFilters`, with the query predicate left off. Three `exists` reads, not
       * counts. A probe that throws leaves `scope` null, which the kernel reads as unknown
       * completeness and undeclared language, and the caller still gets its []. */
      let recall: RecallResult | null = null;
      if (results.length === 0) {
        let scope: RecallSignals["scope"] = null;
        try {
          const sArgs: unknown[] = [[team, KNOWLEDGE_TEAM], HAN_SQL_CLASS, LATIN_SQL_CLASS];
          const sPut = (v: unknown) => { sArgs.push(v); return `$${sArgs.length}`; };
          const sCond = ["team_slug = any($1::text[])"];
          applyFilters((c) => sCond.push(c), sPut);
          const inScope = `from ${SOURCE} where ${sCond.join(" and ")}`;
          const probe = (await p.query(
            `select exists(select 1 ${inScope}) as any_row,
                    exists(select 1 ${inScope} and body ~ $2) as han_row,
                    exists(select 1 ${inScope} and body ~ $3) as latin_row`, sArgs,
          )).rows[0] as { any_row: boolean; han_row: boolean; latin_row: boolean };
          scope = { rows: probe.any_row, han: probe.han_row, latin: probe.latin_row };
        } catch { scope = null; }
        recall = recallResultFrom(recallOutcomeFrom({
          query, unsafe: primary.unsafe, scope,
          // The query's own scripts, tested with the same expression the predicate above splits
          // its clauses on — which lane a clause went down decides what that lane could reach.
          asksHan: HAN_SCALAR_RE.test(query ?? ""), asksLatin: /[A-Za-z0-9]/.test(query ?? ""),
          // The shelves this search spans, named the way they are read back: a `platform` row
          // needs document_read's `scope: "platform"` and a team row does not.
          shelves: team === KNOWLEDGE_TEAM ? [`team:${team}`] : [`team:${team}`, `platform:${KNOWLEDGE_TEAM}`],
          filters: { type, status, initiative, flow, tags, include_superseded: withHistory },
        }));
      }

      // Set only when the raw text could not be read under this platform's query grammar
      // (today: an unterminated quote) and was matched as one literal clause instead, so a
      // narrowed or empty result is not read as "nothing is known".
      const unsafeNote = primary.unsafe
        ? `The query could not be fully parsed (${primary.unsafe}) — it was matched as one literal clause instead.`
        : null;

      // What came back, recorded against who asked — the ids, not just the count.
      // `initiative/path` is the identifier the caller is handed back and the one
      // `document_read` takes. `returned` is what reached the caller; `ranked_total` is
      // everything retrieval considered, bounded by the candidate cap.
      platformEvent({
        actor: who.email, kind: "knowledge.search", subject: (query ?? "").slice(0, 200),
        team,
        detail: {
          returned: results.map((r) => {
            const row = r as { initiative: string; path: string; shelf: string };
            return `${row.shelf}:${row.initiative}/${row.path}`;
          }),
          ranked_total: ranked.length, filters: { type, status, initiative, flow, tags },
          // Whether the conjunction found nothing and the OR pass rescued the query.
          broadened,
          // And, for the ones it did not rescue, which kind of empty they were — replaying it
          // from the query text afterwards cannot recover what the corpus held at the time.
          recall: recall?.result,
        },
      });

      return text(JSON.stringify({
        team,
        query: query ?? null,
        ranked_total: ranked.length,
        returned: results.length,
        withheld: ranked.length - results.length,
        superseded_in_results: superseded,
        // On an empty answer the verdict is the note, because `note` is the line a reading
        // agent acts on. The parse complaint leads when there is one: it names the text that
        // could not be read. A broadened answer says so first among the rest.
        note: recall
          ? [unsafeNote, recall.answer].filter((n): n is string => n !== null).join(" ")
          : unsafeNote
            ?? (broadened
              ? "No document contains all of those terms together. These match SOME of them, best first — "
                + "treat them as leads rather than as an answer, and narrow the question to confirm one."
              : ranked.length > results.length
                ? `${ranked.length - results.length} lower-ranked results not shown — ask a narrower question to see them.`
                : undefined),
        // Which kind of empty, on the empty answers only: `retrieval_inconclusive` is not
        // `no_relevant_match_in_searched_scope`. Absent when there are results.
        recall: recall ?? undefined,
        results,
      }));
    },
  );
}
