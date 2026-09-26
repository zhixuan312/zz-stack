/**
 * Reading the knowledge shelves: `knowledge_search`. `knowledge.ts` mints a node; this file
 * queries what was minted, across both shelves the caller can reach.
 *
 * The shelf a result came from travels with it: a node on the platform shelf is opened with
 * `scope: "platform"` and a node on the team's without it, so a result that does not say which
 * sends a reader to `document_read` with the wrong argument.
 *
 * This handler reads `zz.doc`/`zz.knowledge_node`, not the `zz.search_*` projections.
 * COUPLED: `services/zz-core/src/tenant-info/search.ts` holds the retrieval stack the cutover
 * switches to; this file then keeps one query path, not two behind a flag.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller, recallResultFrom, type RecallResult } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { type KbRow, platformEvent } from "../indexing.js";
import { KNOWLEDGE_TEAM } from "../paths.js";
import { db, teamFor } from "../platform-db.js";

/** The subject kinds a journal tag may name. COUPLED: imported from the write side, so a kind
 *  added there is searchable here without anybody remembering this file. */
import { SUBJECT_KINDS } from "./knowledge.js";

/** What an empty answer concludes, and the signals it concludes from. That file decides which
 *  kind of empty an empty answer is; this one produces its inputs. */
import { recallOutcomeFrom, type RecallSignals } from "./knowledge-search-verdict.js";
/** The query-to-WHERE-clause half, split out by subject — see that file's header. */
import { HAN_SCALAR_RE, HAN_SQL_CLASS, LATIN_SQL_CLASS, QUERY_CONFIG, buildSearchPredicate } from "./search-predicate.js";



export function registerKnowledgeSearch(server: McpServer): void {
  server.registerTool(
    "knowledge_search",
    {
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
       * Ordered by ts_rank_cd — cover density — over the A/B/C weighting indexDoc applies. */
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
        // "Replaced" is recorded in two columns and a current-state filter reads both:
        // `status = 'superseded'` is the journal node's convention, set by knowledge_supersede;
        // `superseded_by` is the pointer, and it is what a _versions/ snapshot carries.
        if (!withHistory) push(`superseded_by is null and status <> 'superseded'`);
      };

      // `team_slug` is selected because the query spans two shelves and a caller reads a path
      // back with `document_read`, which is scoped to their own team. A row that does not carry
      // its shelf answers "does not exist" for a node sitting on the platform's.
      const COLS = `initiative, path, flow, type, status, outcome, approved_by, approved_at,
                    updated_at, title, tags, evidence, superseded_by, team_slug, subject`;
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
       * of them alike. Joined by (team slug, initiative slug), not `zz.doc.initiative_id` — that
       * column is filled by a lazy reconcile pass and can lag a document's own write. */
      const SOURCE = `(
        select d.initiative, d.path, coalesce(i.flow,'') as flow, d.type, d.status, i.outcome,
               d.approved_by, d.approved_at, d.updated_at, d.title, d.tags, d.evidence,
               d.superseded_by, d.team_slug, d.body, d.body_tsv, 'document' as subject
          from zz.doc d
          left join zz.team t on t.slug = d.team_slug
          left join zz.initiative i on i.team_id = t.id and i.slug = d.initiative
        union all
        select '_knowledge' as initiative, path, '' as flow, kind as type, lifecycle as status,
               null as outcome, null as approved_by, null::date as approved_at,
               updated_at, title, tags, evidence, superseded_by, team_slug, body, body_tsv,
               'node' as subject
          from zz.knowledge_node
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

      // Matched terms are marked in markdown rather than ts_headline's default <b>: the rest of
      // this corpus is markdown, and a model reading HTML tags in a snippet treats them as content.
      const headlineOf = (rankExpr: string) => `ts_headline(${QUERY_CONFIG}, body, ${rankExpr},
                 'MaxFragments=2, MaxWords=28, MinWords=12, FragmentDelimiter=" … ",
                  StartSel=**, StopSel=**')`;
      // `rankExpr` is null for a query with no ASCII clause to rank by — a Han-only match has no
      // `body_tsv` signal to score, so every matching row ties on rank and the tiebreak
      // (`updated_at desc`) orders them, the same as a query-less search.
      const rank = primary.rankExpr ? `ts_rank_cd(body_tsv, ${primary.rankExpr})` : "0::float4";
      const head = primary.rankExpr ? headlineOf(primary.rankExpr) : "left(body, 400)";
      const CANDIDATE_CAP = 200;
      const sql = `select ${COLS}, ${rank} as rank, ${head} as snippet
                   from ${SOURCE} where ${primary.sql}
                   order by ${query ? "rank desc, updated_at desc" : "updated_at desc"}
                   limit ${CANDIDATE_CAP}`;
      let lexical = (await p.query(sql, primary.args)).rows as KbRow[];

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
          const wRank = wide.rankExpr ? `ts_rank_cd(body_tsv, ${wide.rankExpr})` : "0::float4";
          const wHead = wide.rankExpr ? headlineOf(wide.rankExpr) : "left(body, 400)";
          lexical = (await p.query(
            `select ${COLS}, ${wRank} as rank, ${wHead} as snippet
               from ${SOURCE} where ${wide.sql}
              order by rank desc, updated_at desc
              limit ${CANDIDATE_CAP}`, wide.args)).rows as KbRow[];
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
          `select ${COLS}, 0::float4 as rank, left(body, 400) as snippet
           from ${SOURCE} where ${tCond.join(" and ")}
           order by cardinality(array(select unnest(tags) intersect select unnest($2::text[]))) desc,
                    updated_at desc
           limit 50`, tArgs)).rows as KbRow[];
      }

      /* Expand to graph neighbours of the top hits. A node's `evidence` names the initiatives
       * it was learned from, so a node citing the same initiative as a strong hit is about the
       * same work even when it shares no vocabulary. Bounded by (seeds x their evidence),
       * fetched in one targeted query — never a scan. */
      const seen = new Set([...lexical, ...tagged].map((r) => `${r.initiative}/${r.path}`));
      // Seeds come from both retrieved lists: a node found only by its tags is as good a
      // starting point for the evidence graph as one found by its words.
      const seedInitiatives = [...new Set(
        [...lexical.slice(0, 10), ...tagged.slice(0, 10)].flatMap((r) => [...(r.evidence ?? []), r.initiative]),
      )];
      let neighbours: KbRow[] = [];
      if (query && seedInitiatives.length) {
        const nArgs: unknown[] = [[team, KNOWLEDGE_TEAM], seedInitiatives];
        const nPut = (v: unknown) => { nArgs.push(v); return `$${nArgs.length}`; };
        const nCond = ["team_slug = any($1::text[])", "(initiative = any($2::text[]) or evidence && $2::text[])"];
        applyFilters((c) => nCond.push(c), nPut);
        neighbours = ((await p.query(
          `select ${COLS}, 0::float4 as rank, left(body, 400) as snippet
           from ${SOURCE} where ${nCond.join(" and ")} order by updated_at desc limit 50`, nArgs,
        )).rows as KbRow[]).filter((r) => !seen.has(`${r.initiative}/${r.path}`));
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

      /* Fill a byte budget best-first rather than truncating at `limit` blindly: reporting what
       * was withheld is what stops a trimmed set being read as the complete match. */
      const BUDGET = 24_000;
      const results: unknown[] = [];
      let spent = 0;
      for (const { row, score, via } of ranked) {
        if (results.length >= want) break;
        const snippet = (row.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
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
