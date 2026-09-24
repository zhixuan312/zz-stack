/**
 * The query-grammar lexer: quotes, exclusions and explicit `OR` alternatives, recognised on
 * the raw scalars a person typed, before any lexical normalization touches them.
 *
 * COUPLED: `identifierTokens`/`analyze` (`tenant-analysis.ts`) split on `.`/`_`/`/`/`-`/`:`,
 * camelCase and Han-scalar boundaries, which would eat this grammar's own syntax — a leading
 * `-` is an exclusion operator, and the same `-` inside `primary_evidence-000037.txt` is
 * punctuation. Only the surface form tells them apart, and that is gone once a normalizer has
 * lowercased and split. Normalization runs afterwards, on each clause's own `.text`.
 *
 * A parallel, narrower grammar to `services/zz-core/src/tenant-info/retrieval.ts`'s own
 * `parseQuery`, which folds a query into the boolean AST the search lanes rank against. Same
 * recognition rules (quote, leading `-`, bare `OR`); nothing here re-implements the other's
 * ranking, wire shape or PostgreSQL mode handling, and neither imports the other.
 *
 * A phrase cannot cross a field boundary: this takes one field's raw text, so there is no
 * multi-field structure inside one call for a quote to span.
 */

// The clause tree

export type QueryClauseKind = "phrase" | "term" | "exclude" | "alternation";

export interface QueryClause {
  readonly kind: QueryClauseKind;
  /** The clause's own content — a phrase's quoted text with the quotes stripped, a term's or
   *  exclusion's word with any leading `-` stripped, or, for `"alternation"`, the original
   *  substring spanning every alternative and the `OR` keywords between them. Never
   *  normalized. */
  readonly text: string;
  /** Only present on `"alternation"` — the operands `OR` joined, in the order they appeared. */
  readonly alternatives?: readonly QueryClause[];
}

export interface QueryAst {
  readonly clauses: readonly QueryClause[];
}

/** Thrown when `text` cannot be parsed under this grammar — so far, only an opened quote that
 *  is never closed. Carries the offending span as scalar offsets rather than degrading to a
 *  bag of words: swallowing the stray `"` would parse a syntax error as if it meant
 *  something. */
export class QueryParseError extends Error {
  constructor(message: string, public readonly span: { readonly start: number; readonly end: number }) {
    super(message);
    this.name = "QueryParseError";
  }
}

// Tokenizing: quotes, a leading `-`, and whitespace — nothing else

function isWhitespaceScalar(ch: string | undefined): boolean {
  return ch === undefined || /\s/u.test(ch);
}

interface RawToken {
  readonly kind: "word" | "phrase";
  /** Content alone: quotes stripped for a phrase, a leading exclusion `-` stripped for a word. */
  readonly text: string;
  readonly excluded: boolean;
  /** Scalar offsets of the token's raw span in `scalars`, including the quotes or the leading
   *  `-`, so an alternation clause can recover its original substring by slicing the source
   *  between its first and last operand. */
  readonly start: number;
  readonly end: number;
}

/** Scans `scalars` left to right, recognizing exactly three things: a double-quoted phrase, a
 *  leading `-` immediately against the next scalar, and whitespace as the only word boundary.
 *  No internal punctuation is inspected, which keeps `primary_evidence-000037.txt` one token.
 *  An unspaced Han run has no whitespace either, so it falls out of the same loop as one
 *  token. */
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

// Folding tokens into clauses

const isOrKeyword = (tok: RawToken): boolean => tok.kind === "word" && !tok.excluded && tok.text === "OR";

/** Folds raw tokens into the clause tree: a phrase or word becomes `"phrase"`/`"term"`, a
 *  `-`-prefixed one becomes `"exclude"` and is never eligible to join an alternation, and an
 *  explicit `OR` between two clauses merges them, and every further `OR`-joined operand, into
 *  one `"alternation"` carrying the original substring across all of them. A dangling `OR` —
 *  nothing before it, or immediately followed by an exclusion — is dropped. */
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

/** Parses `text` under this platform's query grammar and returns the clause tree, each clause
 *  carrying its own original text. Throws `QueryParseError` for an expression this grammar
 *  cannot read rather than degrading it into ordinary terms. Lexical normalization is not run
 *  here: a caller wanting `identifierTokens`/`analyze` applies it to a clause's `.text`
 *  afterwards. */
export function parseQuery(text: string): QueryAst {
  const scalars = Array.from(text);
  const tokens = tokenize(scalars);
  const clauses = buildClauses(tokens, scalars);
  return { clauses };
}
