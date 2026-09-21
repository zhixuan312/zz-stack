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
import { parseCaller, recallResultFrom, type RecallResult } from "@zz/contracts";
import { analyze, parseQuery, QueryParseError, type QueryAst, TEXT_SEARCH_CONFIG } from "@zz/indexing";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { type KbRow, platformEvent } from "../indexing.js";
import { KNOWLEDGE_TEAM } from "../paths.js";
import { db, teamFor } from "../platform-db.js";

/** The subject kinds a journal tag may name — the same closed set the write side checks a
 *  new node's tags against, imported rather than repeated so a kind added there is
 *  searchable here without anybody remembering this file. */
import { SUBJECT_KINDS } from "./knowledge.js";

/** What an empty answer concludes, and the signals it concludes from — split out by subject,
 *  because this file reads the shelves and that one decides which kind of empty an empty
 *  answer is. The verdict itself is the kernel's; that file produces its inputs. */
import { recallOutcomeFrom, type RecallSignals } from "./knowledge-search-verdict.js";


// ── the legacy handler's predicate builder ──────────────────────────────────────────────────
//
// `websearch_to_tsquery(QUERY_CONFIG, …)` pins BOTH a dictionary and, through it, the parser's
// idea of a "word" — and PostgreSQL's built-in parser has no Han word segmentation at all, so
// an unspaced Han run becomes ONE token regardless of which config reads it. "迁移" cannot
// match inside "这个迁移会破坏旧的模式" no matter which dictionary `to_tsquery`/`websearch_to_tsquery`
// is given, because the token boundary is decided before the dictionary ever runs.
//
// So a Han-bearing clause is matched here a different way: as a literal substring of `body`,
// which is exactly what "does this document contain 迁移" means for a script with no
// whitespace-delimited words — and it works against the `body` column that exists TODAY,
// independent of whether `body_tsv` carries `zz-lexical-v2` lexemes yet (Task I-13's
// backfill). An ASCII clause keeps going through `websearch_to_tsquery(QUERY_CONFIG, …)`
// exactly as before, so a query with no Han in it produces the identical predicate a legacy
// caller already depends on — and `QUERY_CONFIG` is the write path's own configuration for a
// Latin term, read from `@zz/indexing`, so "identical" stays a fact about the stored column
// and not just about this file's SQL text.
const HAN_SCALAR_RE = /\p{Script=Han}/u;

/** The same Han run, as a PostgreSQL regex character class, for the scope probe below. Built
 *  from code points rather than written as literal characters: every file in this repository
 *  is English, and a CJK range spelled out is the one exception nobody would remember to keep
 *  matching `HAN_SCALAR_RE`. Bound as a parameter, never spliced into SQL. */
const HAN_SQL_CLASS = `[${String.fromCodePoint(0x4e00)}-${String.fromCodePoint(0x9fff)}]`;

/** A body with a Latin letter in it — the material the `websearch_to_tsquery` lane can reach,
 *  as the counterpart to `HAN_SQL_CLASS` for the lane that cannot.
 *
 *  BOTH ARE EXISTENCE TESTS, NEVER MAJORITY ONES, and the verdict they feed claims no more
 *  than that: one English acronym makes a Chinese document Latin-bearing, one quoted Chinese
 *  sentence makes an English one Han-bearing. What they establish is that a lane had material
 *  in scope it cannot reach — not that the answer was in it. A digit is deliberately not a
 *  Latin letter here while it IS an ASCII clause on the query side: a purely numeric question
 *  does go down the tsvector lane, and a body holding only digits is not material that lane
 *  was shut out of. */
const LATIN_SQL_CLASS = "[A-Za-z]";

/** The text-search configuration every query below is parsed with, quoted for SQL — read from
 *  `@zz/indexing` rather than spelled here, because the WRITE path stores a row's Latin terms
 *  through this same name and the two must never be able to drift apart. They did drift, for
 *  exactly one task: the write path moved to `simple` for the sake of the analyzer's Han terms
 *  while this file went on stemming its queries, and a stemmed query does not match an
 *  unstemmed stored word — not even when the query word and the stored word are the same word.
 *  Nothing here needs the Han configuration: a Han clause is matched as a `body` substring,
 *  never through the vector. */
const QUERY_CONFIG = sqlLiteral(TEXT_SEARCH_CONFIG.latin);

/** Embeds `text` as a single-quoted SQL literal, safely: every embedded quote is doubled. A
 *  Han clause's own text is inlined here rather than bound as `$N` — deliberately, so the
 *  predicate a caller inspects (logging, this file's own gate check) carries the actual
 *  substring being matched rather than a placeholder. */
function sqlLiteral(raw: string): string {
  return `'${raw.replace(/'/g, "''")}'`;
}

/** Escapes `%`, `_` and `\` so an ILIKE pattern stays a literal substring match — a Han clause
 *  is "contains this text", never "contains this text with a caller-controlled wildcard". */
function likePattern(raw: string): string {
  return `%${raw.replace(/([%_\\])/g, "\\$1")}%`;
}

interface SearchPredicateArgs {
  readonly query?: string;
  /** True on the empty-result broadening retry: relax the conjunction across ELIGIBLE
   *  unquoted positive clauses into a disjunction. A quoted phrase, an exclusion, an explicit
   *  `OR` alternation and every filter/scope predicate below are never eligible — they apply
   *  exactly the same whether this is true or false. */
  readonly broadened?: boolean;
  readonly team?: string;
  readonly type?: string;
  readonly status?: string;
  readonly initiative?: string;
  readonly flow?: string;
  readonly tags?: readonly string[];
  /** Same meaning as `include_superseded !== false` on the tool's own argument: false means
   *  current state only. */
  readonly includeSuperseded?: boolean;
}

interface SearchPredicate {
  /** The full WHERE-clause body (already `and`-joined), ready to splice after `where `. */
  readonly sql: string;
  /** Bound parameters `sql`'s `$1`, `$2`, … refer to. */
  readonly args: unknown[];
  /** A ready `to_tsquery`/`websearch_to_tsquery` call for `ts_rank_cd`/`ts_headline` to rank
   *  and excerpt the ASCII portion of the query by, or `null` when the query had no ASCII
   *  clause to rank by (a Han-only query has no `body_tsv` signal to rank on until Task I-13's
   *  backfill lands — every matching row still comes back, just tied on rank). */
  readonly rankExpr: string | null;
  /** Every `zz-lexical-v2` base term (Han unigrams, whole Latin words) the query analysed
   *  into, across every positive and excluded clause — for a caller building tag or
   *  neighbour-expansion candidates from the same query, so a Han query is no longer invisible
   *  to those lanes either. */
  readonly terms: readonly string[];
  /** Raw text of every `-excluded` clause, unmodified. */
  readonly excluded: readonly string[];
  /** Whether this call actually relaxed anything. False when `broadened` was requested but
   *  there was no eligible unquoted positive clause to relax — the caller should not bother
   *  re-running the query in that case, since the predicate did not change. */
  readonly broadened: boolean;
  /** Set when the raw query could not be parsed under the platform's query grammar (today:
   *  an unterminated quote). The offending text is read as one literal clause instead of being
   *  silently flattened into a bag of words — a parse hiccup narrows the search, it never
   *  empties the response outright. */
  readonly unsafe?: string;
}

/** Builds the legacy `knowledge_search` handler's WHERE-clause predicate: team scope, the
 * caller's envelope filters, and the query itself — Han and mixed clauses included, by
 * matching a Han-bearing clause as a literal `body` substring instead of running it through
 * `websearch_to_tsquery(…)`, which cannot see inside an unspaced Han run at all.
 *
 * Pure — no database access — so it is exercised directly by this file's own gate check
 * (`scripts/gate/checks/legacy-han-retrieval.ts`) without a pool or a team to query against. */
export function buildSearchPredicate(a: SearchPredicateArgs): SearchPredicate {
  const args: unknown[] = [];
  const put = (v: unknown): string => { args.push(v); return `$${args.length}`; };

  // SCOPE, FIRST AND ALWAYS. Both query-building paths below (mandatory and the broadened
  // OR-group) are appended to this same `cond` array, so neither can ever drop it — the bug
  // the old broadening pass had, rebuilding `bCond` from an empty array of its own.
  const cond = [`team_slug = any(${put([a.team, KNOWLEDGE_TEAM].filter((t): t is string => Boolean(t)))}::text[])`];
  if (a.type) cond.push(`type = ${put(a.type)}`);
  if (a.status) cond.push(`status = ${put(a.status)}`);
  if (a.initiative) cond.push(`initiative = ${put(a.initiative)}`);
  if (a.flow) cond.push(`flow = ${put(a.flow)}`);
  if (a.tags?.length) cond.push(`tags && ${put(a.tags.map((t) => t.trim().toLowerCase()))}::text[]`);
  if (a.includeSuperseded === false) cond.push(`superseded_by is null and status <> 'superseded'`);

  const terms: string[] = [];
  const excluded: string[] = [];
  const mandatory: string[] = [];
  const eligible: string[] = [];
  let asciiRaw = "";
  let rankExpr: string | null = null;
  let unsafe: string | undefined;

  // `zz-lexical-v2` base terms only — Han unigrams and whole Latin words, unstemmed. The
  // ranking bigrams `analyze` also returns are a ranking hint over a real tsvector, which this
  // ILIKE-based match does not build, so they add nothing here.
  const termsOf = (t: string): string[] => analyze(t).base.map((b) => (b.field === "han" ? b.term : b.term.toLowerCase()));

  if (a.query) {
    let ast: QueryAst;
    try {
      ast = parseQuery(a.query);
    } catch (err) {
      if (!(err instanceof QueryParseError)) throw err;
      unsafe = err.message;
      ast = { clauses: [{ kind: "term", text: a.query }] };
    }

    for (const clause of ast.clauses) {
      if (clause.kind === "exclude") {
        excluded.push(clause.text);
        terms.push(...termsOf(clause.text));
        // EXCLUSIONS ARE NEVER ELIGIBLE FOR BROADENING — a caller who wrote `-测试` wants 测试
        // out of every row broadening rescues too, not just the ones the exact query matched.
        if (HAN_SCALAR_RE.test(clause.text)) {
          mandatory.push(`body not ilike ${sqlLiteral(likePattern(clause.text))}`);
        } else {
          asciiRaw += ` -${clause.text}`;
        }
        continue;
      }
      if (clause.kind === "phrase" || clause.kind === "term") {
        terms.push(...termsOf(clause.text));
        const han = HAN_SCALAR_RE.test(clause.text);
        // ONLY AN UNQUOTED TERM IS EVER ELIGIBLE — a quoted phrase stays mandatory whether or
        // not broadening was asked for, exactly as the Contract requires.
        const mayRelax = a.broadened === true && clause.kind === "term";
        // A FRAGMENT IS BUILT ONLY WHERE IT IS USED, because `put` BINDS A PARAMETER as a side
        // effect. Building the ASCII fragment and then discarding it for the `asciiRaw` path
        // bound a `$N` the SQL never referenced, and PostgreSQL refuses to parse a statement
        // whose numbering skips one — "could not determine data type of parameter $2" for
        // EVERY ascii query. Nothing caught it: no check executes a built predicate against a
        // database, and the two that read its text only assert on what the text contains.
        if (han) {
          const frag = `body ilike ${sqlLiteral(likePattern(clause.text))}`;
          if (mayRelax) eligible.push(frag); else mandatory.push(frag);
        } else if (mayRelax) {
          eligible.push(`body_tsv @@ websearch_to_tsquery(${QUERY_CONFIG}, ${put(clause.text)})`);
        } else {
          // Quotes restored for a phrase clause — `websearch_to_tsquery` reads `"a b"` as the
          // exact-phrase operator, and a reconstruction that dropped them would turn "the exact
          // phrase these two words" into "these two words anywhere", which is not what a caller
          // who quoted it asked for.
          asciiRaw += clause.kind === "phrase" ? ` "${clause.text}"` : ` ${clause.text}`;
        }
        continue;
      }
      // Alternation: survives broadening as ONE mandatory unit (the Contract names it
      // explicitly), ORing its own operands — a Han operand matched by substring, an ASCII one
      // by the same tsvector match every other ASCII clause uses.
      const parts = (clause.alternatives ?? []).map((alt) => {
        terms.push(...termsOf(alt.text));
        return HAN_SCALAR_RE.test(alt.text)
          ? `body ilike ${sqlLiteral(likePattern(alt.text))}`
          : `body_tsv @@ websearch_to_tsquery(${QUERY_CONFIG}, ${put(alt.text)})`;
      });
      if (parts.length) mandatory.push(`(${parts.join(" or ")})`);
    }
  }

  if (asciiRaw.trim()) {
    const q = put(asciiRaw.trim());
    mandatory.push(`body_tsv @@ websearch_to_tsquery(${QUERY_CONFIG}, ${q})`);
    rankExpr = `websearch_to_tsquery(${QUERY_CONFIG}, ${q})`;
  }

  // THE GROUP IS ALWAYS PUSHED; THE FLAG IS NOT. Every eligible clause has to reach the
  // predicate or the query silently loses it — but ONE clause ORed with nothing is the same
  // predicate the exact attempt already ran, so calling that a relaxation made the retry below
  // run a second identical query. Its header had always said one relaxable clause reports
  // `broadened: false`; `eligible.length > 0` said the opposite.
  if (eligible.length) mandatory.push(`(${eligible.join(" or ")})`);
  const broadened = eligible.length > 1;

  cond.push(...mandatory);

  return { sql: cond.join(" and "), args, rankExpr, terms, excluded, broadened, unsafe };
}

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

      /* Pull a CANDIDATE-BOUNDED pool, not a corpus-bounded one: the row count a query
       * materialises never grows with the knowledge base, only with how many documents could
       * plausibly matter for one question. Ordered by ts_rank_cd, so the pool is already the
       * lexical ranking — cover density, which rewards matched terms appearing close together,
       * over the A/B/C weighting indexDoc applies (title > tags > body). */
      // Kept for the TAG and NEIGHBOUR lanes below, each of which still builds its own local
      // `cond`/`args` around it — the query lane no longer does; `buildSearchPredicate` (above
      // this function) carries team scope and every one of these filters itself now, so
      // whichever pass runs (the exact attempt or the broadened retry) can never drop scope
      // the way the old broadened pass — rebuilding `bCond` from an empty array of its own —
      // used to.
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
      /* THE QUERY ITSELF, through `buildSearchPredicate` (Task I-10): the platform's own query
       * grammar (Task I-7) reads quotes, exclusions and an explicit `OR` on the raw text, and
       * `zz-lexical-v2` (Task I-6) analyses each clause — a Han clause matches as a literal
       * `body` substring, since `websearch_to_tsquery(QUERY_CONFIG, …)` cannot see inside an
       * unspaced Han run at all, and every other clause still runs through it exactly as
       * before. */
      const primary = buildSearchPredicate({
        query, team, type, status, initiative, flow, tags,
        includeSuperseded: withHistory ? undefined : false,
      });
      // THE SAME split() SHAPE AS BEFORE, its character class widened rather than replaced —
      // the CJK Unified Ideographs block (and Extension A) joins `[a-z0-9]` so a Chinese query
      // is no longer invisible to the tag and neighbour lanes below, exactly as ASCII words
      // already weren't. Never ':': that is what keeps the SUBJECT_KINDS expansion two blocks
      // down live rather than dead code, and this repository's own gate reads this exact class
      // to hold that guarantee — see "a subject tag is reachable from the word it is about" in
      // scripts/gate/checks/documents-schema.ts.
      const tokens = (query ?? "").toLowerCase().split(/[^a-z0-9\p{Script=Han}]+/u).filter(Boolean);

      // Matched terms are marked so a reader can see WHY a result came back, in markdown
      // rather than ts_headline's default <b>: everything else in this corpus is markdown,
      // and a model reading HTML tags in a snippet treats them as content.
      const headlineOf = (rankExpr: string) => `ts_headline(${QUERY_CONFIG}, body, ${rankExpr},
                 'MaxFragments=2, MaxWords=28, MinWords=12, FragmentDelimiter=" … ",
                  StartSel=**, StopSel=**')`;
      // `rankExpr` is null for a query with no ASCII clause to rank by — a Han-only match has
      // no `body_tsv` signal to score until Task I-13's backfill lands, so every matching row
      // ties on rank and the tiebreak (`updated_at desc`) orders them, same as a query-less
      // search already does.
      const rank = primary.rankExpr ? `ts_rank_cd(body_tsv, ${primary.rankExpr})` : "0::float4";
      const head = primary.rankExpr ? headlineOf(primary.rankExpr) : "left(body, 400)";
      const CANDIDATE_CAP = 200;
      const sql = `select ${COLS}, ${rank} as rank, ${head} as snippet
                   from ${SOURCE} where ${primary.sql}
                   order by ${query ? "rank desc, updated_at desc" : "updated_at desc"}
                   limit ${CANDIDATE_CAP}`;
      let lexical = (await p.query(sql, primary.args)).rows as KbRow[];

      /* AND FOUND NOTHING, so ask the same question with OR before answering "nothing is known".
       *
       * `websearch_to_tsquery` joins unquoted terms with AND. That is the right default — it is
       * what makes a precise question precise — and it is why a LONG question returns an empty
       * set: thirteen words require one document containing all thirteen. The caller reads
       * "nothing is known about this", which is a different and much worse claim than "no single
       * document says all of that at once".
       *
       * MEASURED, not supposed. 43 of one person's 269 real searches came back empty — 16% — and
       * none of them was a near-miss. Re-running three of them with the terms joined by `|`
       * returned 33, 7 and 58 candidates against the same corpus and the same index. The
       * documents were there the whole time; the conjunction hid them.
       *
       * ONLY WHERE THE ANSWER WAS OTHERWISE EMPTY, so no query that works today can be made
       * worse by this. A broadened pool is still ranked by ts_rank_cd, which rewards matched
       * terms appearing close together, so a document matching six of seven terms outranks one
       * matching a single common word — and it is still fused with the tag and evidence lanes
       * rather than replacing them.
       *
       * AND THE CALLER IS TOLD. Every row from a broadened pool carries `via: ["lexical-broad"]`
       * and the response says so, because "no document contains all of this, here is what
       * contains most of it" is a different answer from a match, and a reader who cannot tell
       * them apart will cite the second as the first.
       *
       * ONLY THE ELIGIBLE UNQUOTED POSITIVE CLAUSES RELAX. `buildSearchPredicate({ …,
       * broadened: true })` turns their conjunction into a disjunction and reports back whether
       * anything was actually eligible to relax (`wide.broadened`) — a quoted phrase, an
       * exclusion, an explicit `OR` and every scope/filter predicate are never eligible, so a
       * query built entirely from those (or with only one relaxable clause) reports
       * `broadened: false` and this retry is skipped, exactly as the old "skip a single-token
       * query" guard did, generalised to every clause kind rather than just ASCII words. */
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

      /* Retrieve by TAG as its own list, not as a re-ranking of the lexical one.
       *
       * The tag signal was computed from the lexical hits themselves, so it could only
       * reorder documents full-text had already found, never surface one it had missed.
       * That is precisely the case tags exist for: a node tagged `booking` does not
       * necessarily contain the word someone typed. Fusing a list drawn from another list
       * is not fusion; it is a tiebreak wearing the name. */
      let tagged: KbRow[] = [];
      if (tokens.length) {
        // SUBJECT TAGS ARE REACHABLE FROM THE WORD, which is the whole reason they exist.
        //
        // `tokens` is `buildSearchPredicate`'s `zz-lexical-v2` base terms, so "what have we
        // learned about casebox" yields `casebox` and "迁移 相关的" yields `迁`/`移`/`相`/`关`/`的`
        // — and a node tagged `plugin:casebox` was matched by neither arm: not by
        // `tags && tokens`, because the stored tag is one string with a colon in it, and not by
        // the lexical arm unless the body happened to spell it. The platform validates the kind
        // half, refuses a kind it does not have, and names that exact question in
        // knowledge_add's own description; the retrieval that answers it could not see the tag.
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
      const seen = new Set([...lexical, ...tagged].map((r) => `${r.initiative}/${r.path}`));
      // Seeds come from BOTH retrieved lists: a node found only by its tags is as good a
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

      fuse(lexical, broadened ? "lexical-broad" : "lexical");
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

      /* AN EMPTY ANSWER SAYS WHICH KIND OF EMPTY IT IS — see knowledge-search-verdict.ts.
       *
       * ONLY WHEN NOTHING CAME BACK, so no answer that has results can be changed by this and
       * the extra round trip is paid on the one path with nothing else to say. `results` is
       * empty exactly when `ranked` is: the fill loop stops early only once it has put
       * something in.
       *
       * THE PROBE IS THE SAME SCOPE THE SEARCH RAN IN — both shelves and every filter, through
       * `applyFilters`, with the query predicate left off. Three `exists` reads, not counts:
       * did the declared search cover any material, and is that material written in a script
       * these lanes can reach.
       *
       * AND IT NEVER TURNS AN EMPTY INTO AN ERROR. A probe that throws leaves `scope` null,
       * which the kernel reads as unknown completeness and undeclared language — the honest
       * verdict when coverage could not be established, and the caller still gets its []. */
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
          // The query's own scripts, tested with the same expression the predicate above
          // splits its clauses on — which lane a clause went down is what decides what that
          // lane could reach.
          asksHan: HAN_SCALAR_RE.test(query ?? ""), asksLatin: /[A-Za-z0-9]/.test(query ?? ""),
          // The shelves this search spans, named the way they are read back: a `platform` row
          // needs document_read's `scope: "platform"` and a team row does not.
          shelves: team === KNOWLEDGE_TEAM ? [`team:${team}`] : [`team:${team}`, `platform:${KNOWLEDGE_TEAM}`],
          filters: { type, status, initiative, flow, tags, include_superseded: withHistory },
        }));
      }

      // AN UNPARSEABLE QUERY SAYS SO, rather than the caller reading a narrowed or empty result
      // as "nothing is known" — set only when the raw text could not be read under this
      // platform's query grammar (today: an unterminated quote) and was matched as one literal
      // clause instead.
      const unsafeNote = primary.unsafe
        ? `The query could not be fully parsed (${primary.unsafe}) — it was matched as one literal clause instead.`
        : null;

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
          // Whether the conjunction found nothing and the OR pass rescued the query. This is
          // the rate the fix exists to move, and it is unmeasurable after the fact without it.
          broadened,
          // AND, FOR THE ONES IT DID NOT RESCUE, WHICH KIND OF EMPTY THEY WERE. Same reason:
          // "how often does a search come back unable to conclude rather than having concluded
          // nothing" is the next rate anybody will want, and replaying it from the query text
          // afterwards cannot recover what the corpus held at the time.
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
        // AN EMPTY ANSWER'S NOTE IS THE VERDICT, because `note` is the line a reading agent
        // acts on and an empty result left it unset entirely — the shape where "could not
        // conclude" and "we never decided this" arrive as the same silence. The parse
        // complaint still leads when there is one: it names the text that could not be read,
        // which the authored sentence deliberately does not.
        //
        // A BROADENED ANSWER SAYS SO FIRST among the rest: a reader who takes it for a match
        // will cite documents that do not together say what was asked.
        note: recall
          ? [unsafeNote, recall.answer].filter((n): n is string => n !== null).join(" ")
          : unsafeNote
            ?? (broadened
              ? "No document contains all of those terms together. These match SOME of them, best first — "
                + "treat them as leads rather than as an answer, and narrow the question to confirm one."
              : ranked.length > results.length
                ? `${ranked.length - results.length} lower-ranked results not shown — ask a narrower question to see them.`
                : undefined),
        // WHICH KIND OF EMPTY, on the empty answers only — `retrieval_inconclusive` is not
        // `no_relevant_match_in_searched_scope`, and the whole point is that a caller can tell
        // them apart. Absent when there are results: this adds to what an empty answer says
        // and changes nothing about what a found one returns.
        recall: recall ?? undefined,
        results,
      }));
    },
  );
}
