/**
 * The query-grammar lexer: quotes, exclusions and explicit `OR` alternatives, recognised on
 * the raw scalars a person typed, BEFORE any lexical normalization touches them.
 *
 * WHY THIS RUNS BEFORE NORMALIZATION. `identifierTokens`/`analyze` (`tenant-analysis.ts`)
 * split on `.`/`_`/`/`/`-`/`:`, camelCase and Han-scalar boundaries — useful for matching, but
 * it would also eat this grammar's own syntax: a leading `-` on a term is an exclusion
 * operator, and the same `-` one character into `primary_evidence-000037.txt` is punctuation
 * inside an identifier. Only the SURFACE FORM — an operator's position relative to whitespace
 * and quotes — can tell those two apart, and that information is gone once a normalizer has
 * already lowercased and split the text. So this module reads the raw string first; lexical
 * normalization is left to run afterward, on each clause's own `.text`, exactly as
 * `identifierTokens`'s own header already states it expects ("operates on text a QUERY LEXER
 * has already read for quotes/OR/exclusions").
 *
 * A PARALLEL, NARROWER GRAMMAR TO `services/zz-core/src/tenant-info/retrieval.ts`'s OWN
 * `parseQuery`. That one folds a query into the boolean AST the tenant-information search
 * lanes rank against — `required` terms, PostgreSQL modes, response serialization — and lives
 * where its one caller (`search.ts`) already imports its neighbours from. This one has no
 * caller yet ("final deliverable content is not in this plan") and a narrower job: preserve
 * what a person typed as a clause tree, for whichever consumer reaches for it next. Same
 * recognition rules (quote, leading `-`, bare `OR`), because both are reading the same
 * surface a person types — but two different exported symbols, in two different packages, are
 * not the drift this platform normally refuses: nothing here re-implements the other's
 * ranking, wire shape or PostgreSQL mode handling, and neither imports the other.
 *
 * A PHRASE CANNOT CROSS A FIELD BOUNDARY. This function takes one field's raw text — the
 * caller passes a single string per field it wants parsed (a title, a body). There is no
 * multi-field structure inside one call for a quote to span across, so the invariant holds
 * structurally: nothing downstream of `parseQuery` ever sees a phrase clause whose `.text`
 * reaches past the string it was given.
 */

// ── the clause tree ─────────────────────────────────────────────────────────────────────────

export type QueryClauseKind = "phrase" | "term" | "exclude" | "alternation";

export interface QueryClause {
  readonly kind: QueryClauseKind;
  /** The clause's own content — a phrase's quoted text with the quotes stripped, a term's or
   *  exclusion's word with any leading `-` stripped, or (for `"alternation"`) the original
   *  substring spanning every alternative and the `OR` keywords between them. Never
   *  normalized: whatever splitting or lowercasing a consumer wants happens after this, on
   *  this field. */
  readonly text: string;
  /** Only present on `"alternation"` — the operands `OR` joined, in the order they appeared. */
  readonly alternatives?: readonly QueryClause[];
}

export interface QueryAst {
  readonly clauses: readonly QueryClause[];
}

/** Thrown when `text` cannot be parsed under this grammar — an opened quote that is never
 *  closed, so far the only such case. Carries the offending span (scalar offsets, so a caller
 *  can point at the exact characters) rather than degrading to a bag of words, which is what
 *  the Contract's "never silently flattened" refuses: swallowing the stray `"` and treating
 *  the rest of the query as ordinary terms would parse a syntax error as if it meant something. */
export class QueryParseError extends Error {
  constructor(message: string, public readonly span: { readonly start: number; readonly end: number }) {
    super(message);
    this.name = "QueryParseError";
  }
}

// ── tokenizing: quotes, a leading `-`, and whitespace — nothing else ────────────────────────

function isWhitespaceScalar(ch: string | undefined): boolean {
  return ch === undefined || /\s/u.test(ch);
}

interface RawToken {
  readonly kind: "word" | "phrase";
  /** Content alone: quotes stripped for a phrase, a leading exclusion `-` stripped for a word. */
  readonly text: string;
  readonly excluded: boolean;
  /** Scalar offsets of the token's own RAW span in `scalars` — including the quotes or the
   *  leading `-` — so an alternation clause can recover its original substring by slicing the
   *  source between its first and last operand. */
  readonly start: number;
  readonly end: number;
}

/** Scans `scalars` left to right, recognizing exactly three things: a double-quoted phrase, a
 *  leading `-` immediately against the next scalar (an exclusion), and whitespace as the only
 *  word boundary. No internal punctuation is inspected — `-`, `/`, `.` and everything else
 *  inside a word stay part of it, which is what keeps `primary_evidence-000037.txt` one token
 *  instead of an exclusion plus a fragment. An unspaced Han run has no whitespace in it either,
 *  so it falls out of the same word-scanning loop as a single token, with no separate case. */
function tokenize(scalars: readonly string[]): RawToken[] {
  const tokens: RawToken[] = [];
  const n = scalars.length;
  let i = 0;
  while (i < n) {
    if (isWhitespaceScalar(scalars[i])) { i++; continue; }
    const rawStart = i;
    let excluded = false;
    if (scalars[i] === "-" && !isWhitespaceScalar(scalars[i + 1])) {
      excluded = true;
      i++;
    }
    if (scalars[i] === "\"") {
      const contentStart = i + 1;
      let j = contentStart;
      while (j < n && scalars[j] !== "\"") j++;
      if (j >= n) {
        throw new QueryParseError(
          `unterminated quote at scalar offset ${rawStart}`, { start: rawStart, end: n });
      }
      tokens.push({ kind: "phrase", text: scalars.slice(contentStart, j).join(""), excluded, start: rawStart, end: j + 1 });
      i = j + 1;
      continue;
    }
    let k = i;
    while (k < n && !isWhitespaceScalar(scalars[k])) k++;
    tokens.push({ kind: "word", text: scalars.slice(i, k).join(""), excluded, start: rawStart, end: k });
    i = k;
  }
  return tokens;
}

// ── folding tokens into clauses ──────────────────────────────────────────────────────────────

const isOrKeyword = (tok: RawToken): boolean => tok.kind === "word" && !tok.excluded && tok.text === "OR";

/** Folds raw tokens into the clause tree: a phrase or word becomes `"phrase"`/`"term"`, a
 *  `-`-prefixed one becomes `"exclude"` and is never eligible to join an alternation, and an
 *  explicit `OR` between two clauses merges them (and every further `OR`-joined operand) into
 *  one `"alternation"` clause carrying the original substring across all of them. A dangling
 *  `OR` — nothing before it, or immediately followed by an exclusion — contributes no operator
 *  and is simply dropped, the same tolerant reading `retrieval.ts`'s own `buildClauses` gives
 *  the same case. */
function buildClauses(tokens: readonly RawToken[], scalars: readonly string[]): QueryClause[] {
  const clauses: QueryClause[] = [];
  const spans: { start: number; end: number }[] = [];
  let pendingOr = false;

  for (const tok of tokens) {
    if (isOrKeyword(tok)) {
      if (clauses.length > 0) pendingOr = true;
      continue;
    }
    const clause: QueryClause = tok.excluded
      ? { kind: "exclude", text: tok.text }
      : tok.kind === "phrase"
        ? { kind: "phrase", text: tok.text }
        : { kind: "term", text: tok.text };

    if (tok.excluded) {
      // A hard exclusion never joins an alternation — "-测试 OR 模式" excludes 测试 and offers
      // 模式 as its own term, not "either 测试 or 模式".
      clauses.push(clause);
      spans.push({ start: tok.start, end: tok.end });
      pendingOr = false;
      continue;
    }

    if (pendingOr && clauses.length > 0) {
      const lastIndex = clauses.length - 1;
      const last = clauses[lastIndex]!;
      const lastSpan = spans[lastIndex]!;
      const merged: QueryClause = last.kind === "alternation"
        ? { kind: "alternation", text: scalars.slice(lastSpan.start, tok.end).join(""), alternatives: [...(last.alternatives ?? []), clause] }
        : { kind: "alternation", text: scalars.slice(lastSpan.start, tok.end).join(""), alternatives: [last, clause] };
      clauses[lastIndex] = merged;
      spans[lastIndex] = { start: lastSpan.start, end: tok.end };
      pendingOr = false;
      continue;
    }

    clauses.push(clause);
    spans.push({ start: tok.start, end: tok.end });
  }
  return clauses;
}

/** Parses `text` under this platform's query grammar — quoted phrases, a leading `-` as an
 *  exclusion, and a bare `OR` between two operands as an explicit alternative — and returns
 *  the clause tree, each clause carrying its own original text. Throws `QueryParseError` for
 *  an expression this grammar cannot read (today: an unterminated quote) rather than
 *  degrading it into ordinary terms. Lexical normalization is deliberately not run here: a
 *  caller wanting `identifierTokens`/`analyze` over a clause applies it to that clause's own
 *  `.text`, after this stage, never before it. */
export function parseQuery(text: string): QueryAst {
  const scalars = Array.from(text);
  const tokens = tokenize(scalars);
  const clauses = buildClauses(tokens, scalars);
  return { clauses };
}
