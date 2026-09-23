/**
 * A QUERY BECOMES A WHERE CLAUSE — that subject, and nothing about the tool that runs it.
 *
 * Split out of `knowledge-search.ts`, which had reached the size where a file in this
 * repository has always turned out to hold two subjects. The other one is the TOOL: its
 * arguments, the union it reads, the lanes it reports, the verdict it puts on an empty answer.
 * None of that bears on turning the text somebody typed into SQL.
 *
 * This is also the half that is DRIVEN DIRECTLY by four gate checks — legacy-han-retrieval,
 * search-predicate-parameters, text-search-config-agreement and data-telemetry's own probe —
 * because it is pure: it opens no database, takes no connection, and never has. That is what
 * makes it checkable offline, and it is worth keeping true of a file rather than of a function
 * inside a file that does open one.
 */
import { analyze, parseQuery, QueryParseError, type QueryAst, TEXT_SEARCH_CONFIG } from "@zz/indexing";

import { KNOWLEDGE_TEAM } from "../paths.js";
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
export const HAN_SCALAR_RE = /\p{Script=Han}/u;

/** The same Han run, as a PostgreSQL regex character class, for the scope probe below. Built
 *  from code points rather than written as literal characters: every file in this repository
 *  is English, and a CJK range spelled out is the one exception nobody would remember to keep
 *  matching `HAN_SCALAR_RE`. Bound as a parameter, never spliced into SQL. */
export const HAN_SQL_CLASS = `[${String.fromCodePoint(0x4e00)}-${String.fromCodePoint(0x9fff)}]`;

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
export const LATIN_SQL_CLASS = "[A-Za-z]";

/** The text-search configuration every query below is parsed with, quoted for SQL — read from
 *  `@zz/indexing` rather than spelled here, because the WRITE path stores a row's Latin terms
 *  through this same name and the two must never be able to drift apart. They did drift, for
 *  exactly one task: the write path moved to `simple` for the sake of the analyzer's Han terms
 *  while this file went on stemming its queries, and a stemmed query does not match an
 *  unstemmed stored word — not even when the query word and the stored word are the same word.
 *  Nothing here needs the Han configuration: a Han clause is matched as a `body` substring,
 *  never through the vector. */
export const QUERY_CONFIG = sqlLiteral(TEXT_SEARCH_CONFIG.latin);

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
