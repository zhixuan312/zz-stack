/**
 * Reading the knowledge shelves: `knowledge_search`.
 *
 * SPLIT OUT OF knowledge.ts BY SUBJECT. That file MINTS a node — numbering it, requiring its
 * evidence, writing the index row and the append-only log — and this one QUERIES what was
 * minted, across both shelves the caller can reach. The two share the store and nothing else:
 * the write side is about what makes a node legitimate, the read side is scoring, shelf
 * resolution, provenance and what is deliberately withheld.
 *
 * The shelf a result came from travels WITH it. A node on the platform shelf is opened with
 * `scope: "platform"` and a node on the team's without it, so a result that did not say which
 * sent readers to `document_read` with the wrong argument and answered "does not exist" — the
 * failure two knowledge nodes on this deployment record having already happened.
 *
 * ── I-22: WHERE THE TENANT-INFORMATION SEARCH PATH IS, AND WHY IT IS NOT YET THIS HANDLER ───
 *
 * `services/zz-core/src/tenant-info/search.ts`'s `searchTenantInformation` composes the whole
 * tenant-information retrieval stack — `parseQuery` → `loadCorpusRegistry` → `resolveCorpora` →
 * the four lanes and RRF in `search()` → `matchesArtifact` → `serializeResults`. Until it
 * existed, every one of those pieces was reachable only from a test that called it directly.
 * It was written HERE, in the integration target the approved specification declares
 * ("services/zz-core/src/tools/knowledge-search.ts, change: modified"), and moved one directory
 * over when this file reached 703 lines against a measured 700-line ceiling — at the seam this
 * file's own banner had already drawn between the two stores it would have read from.
 *
 * THE LIVE `knowledge_search` HANDLER STILL READS `zz.doc`/`zz.knowledge_node`, DELIBERATELY,
 * and repointing it is a cutover step rather than a wiring step. Migration 070 — which creates
 * `zz.artifact`, `zz.artifact_event` and the three `zz.search_*` projections this new path
 * queries — declares `-- requires-extension: pg_textsearch` and `-- requires-extension:
 * pg_trgm` in its own header, and `services/gateway/src/db.ts` DEFERS a migration whose
 * extension the cluster cannot supply: skipped, not recorded as applied. On the deployment this
 * platform actually runs, those tables therefore do not exist, and nothing has ever projected a
 * row into them (`packages/indexing/src/tenant-rebuild.ts` is the only writer, and it runs
 * against an isolated target generation). A handler pointed at them today would answer
 * `relation "zz.search_current" does not exist` for every caller — turning the one tool that
 * reads this team's documents into an outage, with the documents themselves untouched and
 * unreachable. The switch belongs to the rehearsed cutover (I-20's conversion and I-21's
 * backup/cutover), after which this file keeps ONE query path, not two behind a flag.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { type KbRow, platformEvent } from "../indexing.js";
import { KNOWLEDGE_TEAM } from "../paths.js";
import { db, teamFor } from "../platform-db.js";

/** The subject kinds a journal tag may name — the same closed set the write side checks a
 *  new node's tags against, imported rather than repeated so a kind added there is
 *  searchable here without anybody remembering this file. */
import { SUBJECT_KINDS } from "./knowledge.js";


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
      const tokens = (query ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

      /* Pull a CANDIDATE-BOUNDED pool, not a corpus-bounded one: the row count a query
       * materialises never grows with the knowledge base, only with how many documents could
       * plausibly matter for one question. Ordered by ts_rank_cd, so the pool is already the
       * lexical ranking — cover density, which rewards matched terms appearing close together,
       * over the A/B/C weighting indexDoc applies (title > tags > body). */
      // Built once and applied to BOTH queries below. The neighbour expansion used to
      // rebuild a subset by hand and dropped initiative, flow and tags — so a caller who
      // scoped a search to one initiative got rows from others, arriving as via:["evidence"]
      // with no indication that the scope had been ignored. A filter the caller asked for is
      // not a hint to the ranker.
      // The caller's own documents AND the platform's journal. Knowledge is
      // filed under zz-platform now, so a search scoped to one team alone would
      // return a team's specs and none of the lessons written about them.
      const cond = ["team_slug = any($1::text[])"];
      const args: unknown[] = [[team, KNOWLEDGE_TEAM]];
      const put = (v: unknown) => { args.push(v); return `$${args.length}`; };
      const applyFilters = (push: (sql: string) => void, add: (v: unknown) => string) => {
        if (type) push(`type = ${add(type)}`);
        if (status) push(`status = ${add(status)}`);
        if (initiative) push(`initiative = ${add(initiative)}`);
        if (flow) push(`flow = ${add(flow)}`);
        // Lowercased on the way in, because the stored side is: a filter is a value arriving
        // from outside and has to be brought to the one spelling, exactly as an address typed
        // as a tool argument is. Without this, tags are stored lowercase and a caller who
        // filters `plugin:CaseBox` gets an empty result that reads as "nothing is known".
        if (tags?.length) push(`tags && ${add(tags.map((t) => t.trim().toLowerCase()))}::text[]`);
        // "Replaced" is recorded in two columns, and a filter for current state has to
        // read both. `status = 'superseded'` is the journal node's convention, set by
        // knowledge_supersede; `superseded_by` is the pointer, and it is what a _versions/
        // snapshot carries. This tested the first alone, so `include_superseded: false` —
        // whose whole purpose is "current state only" — returned every frozen approval
        // snapshot in the corpus, three rows deep for one spec.
        if (!withHistory) push(`superseded_by is null and status <> 'superseded'`);
      };
      applyFilters((c) => cond.push(c), put);

      // team_slug IS SELECTED, because the query spans TWO shelves and the answer used to
      // discard which one each row came from. A caller then read a path back with document_read,
      // which is scoped to their own team, and got "does not exist" for a node that is right
      // there on the platform's shelf. Observed on a live ops-flow round: the agent searched,
      // found the two nodes describing the exact casebox refusal it was about to hit, could not
      // read either, hit the refusal, and asked a non-technical person to build the thing by
      // hand. The lessons were visible and unreachable, which is worse than absent — it looks
      // like the knowledge base is working.
      const COLS = `initiative, path, flow, type, status, outcome, approved_by, approved_at,
                    updated_at, title, tags, evidence, superseded_by, team_slug, subject`;
      /* TWO SUBJECTS, UNIONED HERE AND NOWHERE ELSE — which is the point of the split.
       *
       * This search deliberately spans a team's documents AND the platform's journal, so it
       * reads two tables. They are separate because their lifecycles are: a document is
       * `approved` when a person agreed, a node is `adopted` until something better replaces
       * it. Each side maps its own vocabulary into the shared shape HERE, once, explicitly —
       * rather than the two sharing one `status` column and every caller downstream having to
       * remember which meaning it carries.
       *
       * `subject` travels with the row so a reader can tell them apart without inferring it
       * from the path, which is how the old shape was read and why it kept being got wrong.
       *
       * A node has no flow, outcome or approval — 0 of 853 ever did — so those are constants
       * on that side rather than columns it was made to carry. */
      const SOURCE = `(
        select initiative, path, flow, type, status, outcome, approved_by, approved_at,
               updated_at, title, tags, evidence, superseded_by, team_slug, body, body_tsv,
               'document' as subject
          from zz.doc
        union all
        select '_knowledge' as initiative, path, '' as flow, kind as type, lifecycle as status,
               null as outcome, null as approved_by, null::date as approved_at,
               updated_at, title, tags, evidence, superseded_by, team_slug, body, body_tsv,
               'node' as subject
          from zz.knowledge_node
      ) k`;
      let rank = "0::float4", head = "left(body, 400)";
      if (query) {
        const q = put(query);
        // websearch_to_tsquery accepts what a person actually types — quoted phrases, OR,
        // leading minus — and never throws on syntax, which plainto_ silently flattens and
        // to_tsquery rejects outright.
        cond.push(`body_tsv @@ websearch_to_tsquery('english', ${q})`);
        rank = `ts_rank_cd(body_tsv, websearch_to_tsquery('english', ${q}))`;
        // Matched terms are marked so a reader can see WHY a result came back, in markdown
        // rather than ts_headline's default <b>: everything else in this corpus is markdown,
        // and a model reading HTML tags in a snippet treats them as content.
        head = `ts_headline('english', body, websearch_to_tsquery('english', ${q}),
                 'MaxFragments=2, MaxWords=28, MinWords=12, FragmentDelimiter=" … ",
                  StartSel=**, StopSel=**')`;
      }
      const CANDIDATE_CAP = 200;
      const sql = `select ${COLS}, ${rank} as rank, ${head} as snippet
                   from ${SOURCE} where ${cond.join(" and ")}
                   order by ${query ? "rank desc, updated_at desc" : "updated_at desc"}
                   limit ${CANDIDATE_CAP}`;
      const pooled = (await p.query(sql, args)).rows as KbRow[];

      /* Retrieve by TAG as its own list, not as a re-ranking of the lexical one.
       *
       * The tag signal was computed from `pooled` — the lexical hits — so it could only
       * reorder documents full-text had already found, never surface one it had missed.
       * That is precisely the case tags exist for: a node tagged `booking` does not
       * necessarily contain the word someone typed. Fusing a list drawn from another list
       * is not fusion; it is a tiebreak wearing the name. */
      let tagged: KbRow[] = [];
      if (tokens.length) {
        // SUBJECT TAGS ARE REACHABLE FROM THE WORD, which is the whole reason they exist.
        //
        // `tokens` splits the query on everything that is not a letter or a digit, so "what
        // have we learned about casebox" yields `casebox` — and a node tagged `plugin:casebox` was matched by
        // neither arm: not by `tags && tokens`, because the stored tag is one string with a
        // colon in it, and not by the lexical arm unless the body happened to spell it. The
        // platform validates the kind half, refuses a kind it does not have, and names that
        // exact question in knowledge_add's own description; the retrieval that answers it
        // could not see the tag.
        //
        // Expanded on the QUERY side rather than the stored side: a compound candidate is
        // only ever a tag somebody actually wrote, so `&&` and the overlap count that orders
        // these rows both keep working unchanged. Five kinds, so the list stays small.
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
       * it was learned from, and that is the edge this store has: a node that cites the same
       * initiative as a strong hit is about the same work even when it shares no vocabulary.
       * Bounded by (seeds x their evidence), fetched in one targeted query — never a scan. */
      const seen = new Set([...pooled, ...tagged].map((r) => `${r.initiative}/${r.path}`));
      // Seeds come from BOTH retrieved lists: a node found only by its tags is as good a
      // starting point for the evidence graph as one found by its words.
      const seedInitiatives = [...new Set(
        [...pooled.slice(0, 10), ...tagged.slice(0, 10)].flatMap((r) => [...(r.evidence ?? []), r.initiative]),
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

      /* Reciprocal Rank Fusion over three ranked lists, k=60. RRF beats score-averaging
       * here because the three signals are not on a common scale: ts_rank_cd is a float,
       * tag overlap is a count, neighbour proximity is a boolean. Fusing POSITIONS makes
       * them comparable without inventing weights for quantities that cannot be compared. */
      const RRF_K = 60;
      const key = (r: KbRow) => `${r.initiative}/${r.path}`;
      const fused = new Map<string, { row: KbRow; score: number; via: Set<string> }>();
      const fuse = (list: KbRow[], via: string) => list.forEach((row, i) => {
        const k = key(row);
        const e = fused.get(k) ?? { row, score: 0, via: new Set<string>() };
        e.score += 1 / (RRF_K + i + 1); e.via.add(via); fused.set(k, e);
      });

      fuse(pooled, "lexical");
      fuse(tagged, "tag");
      fuse(neighbours, "evidence");

      const ranked = [...fused.values()].sort((a, b) => b.score - a.score);

      /* Fill a byte budget best-first rather than truncating at `limit` blindly: a caller's
       * context is finite, and reporting what was withheld is what stops a trimmed set being
       * read as the complete match. */
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
          // WHICH SHELF, and therefore how to read it back. `platform` rows live in the
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

      const superseded = results.filter((r) => (r as { status: string }).status === "superseded").length;

      // WHAT CAME BACK, recorded against who asked. Until this line the knowledge base could
      // say what had been written into it and nothing at all about what anyone read out —
      // `knowledge_add` and `knowledge_supersede` each left three records and a search left
      // none. "Which nodes does anybody actually read" is the question that decides whether a
      // node earned its place, and it was unanswerable on a store with hundreds of them.
      //
      // THE IDS, not just the count. A row saying "someone searched and got nine results" is
      // the same shape of half-measurement as a run that records that it happened and not what
      // it did: it cannot tell a node nobody ever retrieves from one retrieved every day.
      // `initiative/path` is the identifier the caller is handed back and the one
      // `document_read` takes, so it is the id that joins to anything else.
      //
      // THE RETURNED SET, not the ranked one. `ranked` is everything retrieval considered,
      // which is bounded by a candidate cap and says more about the query than about what
      // reached a reader; `results` is what was actually put in front of the caller. Both
      // numbers are kept so the difference stays visible.
      platformEvent({
        actor: who.email, kind: "knowledge.search", subject: (query ?? "").slice(0, 200),
        team,
        detail: {
          returned: results.map((r) => {
            const row = r as { initiative: string; path: string; shelf: string };
            return `${row.shelf}:${row.initiative}/${row.path}`;
          }),
          ranked_total: ranked.length, filters: { type, status, initiative, flow, tags },
        },
      });

      return text(JSON.stringify({
        team,
        query: query ?? null,
        ranked_total: ranked.length,
        returned: results.length,
        withheld: ranked.length - results.length,
        superseded_in_results: superseded,
        note:
          ranked.length > results.length
            ? `${ranked.length - results.length} lower-ranked results not shown — ask a narrower question to see them.`
            : undefined,
        results,
      }));
    },
  );
  // ── rebuilding a team's knowledge index ────────────────────────────────────────────────
  //
}
