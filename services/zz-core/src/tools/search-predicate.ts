/**
 * Turning a query into a WHERE clause. The tool that runs it — its arguments, the union it
 * reads, the lanes it reports, the verdict it puts on an empty answer — is `knowledge-search.ts`.
 *
 * Pure: it opens no database and takes no connection, which is what lets the gate checks
 * (legacy-han-retrieval, search-predicate-parameters, text-search-config-agreement and
 * data-telemetry's probe) drive it offline.
 */
import { analyze, parseQuery, QueryParseError, type QueryAst, TEXT_SEARCH_CONFIG } from "@zz/indexing";

import { KNOWLEDGE_TEAM } from "../paths.js";
// PostgreSQL's built-in parser has no Han word segmentation, so an unspaced Han run is one
// token whatever dictionary reads it: "迁移" cannot match inside "这个迁移会破坏旧的模式" through
// `to_tsquery`/`websearch_to_tsquery`, because the token boundary is decided before the
// dictionary runs.
//
// So a Han-bearing clause is matched as a literal substring of `body`. An ASCII clause still
// goes through `websearch_to_tsquery(QUERY_CONFIG, …)`, so a query with no Han in it produces
// the predicate a legacy caller already depends on.
export const HAN_SCALAR_RE = /\p{Script=Han}/u;

/** The same Han run as a PostgreSQL regex character class, for the scope probe below. Built from
 *  code points rather than literal characters, since every file in this repository is English.
 *  Bound as a parameter, never spliced into SQL. */
export const HAN_SQL_CLASS = `[${String.fromCodePoint(0x4e00)}-${String.fromCodePoint(0x9fff)}]`;

/** A body with a Latin letter in it — the counterpart to `HAN_SQL_CLASS` for the lane that
 *  cannot reach Han.
 *
 *  Both are existence tests, never majority ones: one English acronym makes a Chinese document
 *  Latin-bearing. They establish that a lane had material in scope it cannot reach, not that the
 *  answer was in it. DELIBERATE: a digit is not a Latin letter here while it is an ASCII clause
 *  on the query side — a purely numeric question does go down the tsvector lane. */
export const LATIN_SQL_CLASS = "[A-Za-z]";

/** The text-search configuration every query below is parsed with, quoted for SQL. COUPLED: read
 *  from `@zz/indexing` because the write path stores a row's Latin terms through this same name,
 *  and a stemmed query does not match an unstemmed stored word. Nothing here needs the Han
 *  configuration: a Han clause is matched as a `body` substring, never through the vector. */
export const QUERY_CONFIG = sqlLiteral(TEXT_SEARCH_CONFIG.latin);

/** Embeds `text` as a single-quoted SQL literal: every embedded quote is doubled. DELIBERATE: a
 *  Han clause's own text is inlined here rather than bound as `$N`, so the predicate a caller
 *  inspects carries the actual substring being matched. */
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
  /** True on the empty-result broadening retry: relax the conjunction across eligible
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
  /** A ready `to_tsquery`/`websearch_to_tsquery` call for `ts_rank_cd`/`ts_headline` to rank and
   *  excerpt the ASCII portion by, or `null` when the query had no ASCII clause. A Han-only
   *  query's matching rows all come back, tied on rank. */
  readonly rankExpr: string | null;
  /** Every `zz-lexical-v2` base term (Han unigrams, whole Latin words) the query analysed into,
   *  across every positive and excluded clause, for a caller building tag or neighbour-expansion
   *  candidates from the same query. */
  readonly terms: readonly string[];
  /** Raw text of every `-excluded` clause, unmodified. */
  readonly excluded: readonly string[];
  /** Whether this call actually relaxed anything. False when `broadened` was requested but
   *  there was no eligible unquoted positive clause to relax — the caller should not bother
   *  re-running the query in that case, since the predicate did not change. */
  readonly broadened: boolean;
  /** Set when the raw query could not be parsed under the platform's query grammar (today: an
   *  unterminated quote). The offending text is read as one literal clause, so a parse hiccup
   *  narrows the search rather than emptying the response. */
  readonly unsafe?: string;
}

/** Builds the legacy `knowledge_search` handler's WHERE-clause predicate: team scope, the
 * caller's envelope filters, and the query itself — a Han-bearing clause as a literal `body`
 * substring, everything else through `websearch_to_tsquery(…)`.
 *
 * Pure, so `scripts/gate/checks/legacy-han-retrieval.ts` exercises it without a pool. */
export function buildSearchPredicate(a: SearchPredicateArgs): SearchPredicate {
  const args: unknown[] = [];
  const put = (v: unknown): string => { args.push(v); return `$${args.length}`; };

  // Scope first and always: both query-building paths below are appended to this same `cond`
  // array, so neither can drop it.
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

  // `zz-lexical-v2` base terms only — Han unigrams and whole Latin words, unstemmed. The ranking
  // bigrams `analyze` also returns are a hint over a real tsvector, which this ILIKE-based match
  // does not build.
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
        // Exclusions are never eligible for broadening: a caller who wrote `-测试` wants 测试 out
        // of every row broadening rescues too.
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
        // Only an unquoted term is ever eligible; a quoted phrase stays mandatory whether or not
        // broadening was asked for.
        const mayRelax = a.broadened === true && clause.kind === "term";
        // A fragment is built only where it is used, because `put` binds a parameter as a side
        // effect. Building the ASCII fragment and discarding it binds a `$N` the SQL never
        // references, and PostgreSQL refuses to parse a statement whose numbering skips one.
        if (han) {
          const frag = `body ilike ${sqlLiteral(likePattern(clause.text))}`;
          if (mayRelax) eligible.push(frag); else mandatory.push(frag);
        } else if (mayRelax) {
          eligible.push(`body_tsv @@ websearch_to_tsquery(${QUERY_CONFIG}, ${put(clause.text)})`);
        } else {
          // Quotes restored for a phrase clause: `websearch_to_tsquery` reads `"a b"` as the
          // exact-phrase operator.
          asciiRaw += clause.kind === "phrase" ? ` "${clause.text}"` : ` ${clause.text}`;
        }
        continue;
      }
      // Alternation survives broadening as one mandatory unit, ORing its own operands — a Han
      // operand by substring, an ASCII one by the same tsvector match.
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

  // The group is always pushed; the flag is not. Every eligible clause has to reach the
  // predicate, but one clause ORed with nothing is the predicate the exact attempt already ran,
  // so one relaxable clause reports `broadened: false`.
  if (eligible.length) mandatory.push(`(${eligible.join(" or ")})`);
  const broadened = eligible.length > 1;

  cond.push(...mandatory);

  return { sql: cond.join(" and "), args, rankExpr, terms, excluded, broadened, unsafe };
}
