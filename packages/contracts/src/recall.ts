/**
 * What a recall episode is allowed to conclude: `RecallResult`, `RecallFinding`, and the one pure
 * mapping that turns a search outcome into one of them.
 *
 * Three outcomes all look like "nothing came back" and are three different facts:
 *
 *   `retrieval_inconclusive`                 the search could not answer — it did not report how
 *                                            far it got, it was not qualified for the language
 *                                            the material is written in, a requested scope was
 *                                            never searched, candidates were withheld, the
 *                                            episode's budget ran out, or the service was
 *                                            unavailable. Says nothing about what the team
 *                                            decided.
 *   `no_relevant_match_in_searched_scope`    the search ran cleanly to completion, and nothing
 *                                            matched under that search.
 *   `findings`                               something matched, and each finding says how
 *                                            strongly it is supported.
 *
 * The sentence in `answer` for the two negative exits and the error exit is authored here,
 * deterministically, so the three can never be merged by a summariser that found them all equally
 * empty. A negative claims no more than its declared query, scopes, filters, visible corpus and
 * completion limits, and the sentence says so.
 *
 * DELIBERATE: this builds no second store. It is a result type and a pure function over a search
 * outcome somebody else already obtained — it runs no query, reaches no network, and holds no
 * state.
 *
 * COUPLED: `matchKindFromVia` below mirrors the `via` values `services/zz-core`'s
 * `knowledge_search` returns. `@zz/contracts` sits below the services and must never depend
 * upward, so the mapping is stated here rather than imported from there.
 */

// The closed sets

/**
 * The four exits `sdlc-recall`'s own skill contract declares, and they must never be merged.
 * `no_team` is the error exit: the search is team-scoped and the caller was not acting for a team,
 * so nothing was searched at all — a different fact again from a search that ran.
 */
export type RecallOutcome =
  | "findings"
  | "no_relevant_match_in_searched_scope"
  | "retrieval_inconclusive"
  | "no_team";

/**
 * How strongly a finding is claimed, weakest last. `author_inference` is what the agent concluded
 * rather than what any source states, and it is the ceiling for anything whose original text has
 * not been read: a snippet says a source is about a topic, never what it concluded.
 * `stated_intent` is a document asserting an intent at a date, not a settled decision.
 */
export type RecallClaimKind =
  | "stated_intent"
  | "approved_decision"
  | "reported_result"
  | "observed_result"
  | "distilled_learning"
  | "author_inference";

/** Which retrieval lane produced the hit. A `*_lead` kind is a lead, not an answer. */
export type RecallMatchKind = "lexical" | "tag" | "broadened_lead" | "graph_lead";

/** Whether the original text behind a finding was actually opened and read. */
export type RecallSupport = "original_text_read" | "lead_unconfirmed";

/** How far the search got. Absent is read as `unknown`, never as complete. */
export type RecallCompleteness = "complete_for_declared_search" | "partial" | "unknown";

/** What the search service itself reported about the call. */
export type RecallReceiptStatus = "ok" | "unavailable" | "no_team";

/** A finding's own currency. `superseded` is the most valuable thing recall can find. */
export type RecallFindingStatus = "adopted" | "superseded" | "unknown";

/**
 * Every reason a search may not claim a clean empty, in one closed set. Each is rendered into the
 * `answer` sentence and into one `unresolved_questions` entry; none is a field on `RecallResult`.
 */
export type RecallBlocker =
  | "service_unavailable"
  | "unknown_index_progress"
  | "incomplete_search"
  | "language_unqualified"
  | "unsupported_scope"
  | "scope_not_searched"
  | "candidates_withheld"
  | "budget_exhausted";

// What goes in

/** A quote in the language the source was written in. A translation is a search hypothesis, never
 *  evidence, and is never written back into the original document — so `language` is the source's
 *  language and `text` is its own words, not a rendering of them. */
export interface RecallQuote {
  readonly text: string;
  readonly language: string;
}

/** One line of the episode's finite budget. Exhausted means `spent >= limit`. */
export interface RecallBudgetLine {
  readonly limit: number;
  readonly spent: number;
}

/** The episode's finite query, page, read and elapsed budget. A search that stopped because
 *  it ran out did not finish, and may not claim a clean empty. */
export interface RecallEpisodeBudget {
  readonly queries?: RecallBudgetLine;
  readonly pages?: RecallBudgetLine;
  readonly reads?: RecallBudgetLine;
  readonly elapsed_ms?: RecallBudgetLine;
}

/**
 * What one search call reported about itself, as opposed to what it returned. Only `status` is
 * required: a caller that cannot say how complete its search was has said `unknown`, which is the
 * honest reading and the one that blocks a clean empty.
 *
 * Absence rules, because they decide the outcome: `completeness` absent is `unknown`;
 * `language_qualified` absent or null is not qualified; `withheld` absent is zero, because a
 * receipt that declares itself complete for its declared search has already said nothing was
 * trimmed; `scopes_searched` absent means the receipt accounts for no requested scope.
 */
export interface RecallSearchReceipt {
  readonly status: RecallReceiptStatus;
  /** The identifier this call is cited by. Absent is allowed: a receipt with no ref cannot be
   *  cited, which is a gap in the record rather than a reason to doubt the search. */
  readonly ref?: string | null;
  readonly query?: string | null;
  readonly completeness?: RecallCompleteness;
  /** True only when the query was framed so the index can match the material's language. An
   *  index that splits an unspaced script on whitespace cannot match a word inside a run of
   *  it, so an empty result there is a fact about retrieval and not about the team. */
  readonly language_qualified?: boolean | null;
  /** Ranked candidates not returned. Non-zero means the set in hand is not the whole match. */
  readonly withheld?: number | null;
  readonly scopes_searched?: readonly string[];
  readonly unsupported_scopes?: readonly string[];
  /** The filters in force, carried so the negative claim can be read back against them. */
  readonly filters?: Readonly<Record<string, unknown>>;
}

/** One hit, as the caller assessed it after reading whatever it read. Every field but the
 *  lane is optional: a row straight out of the search has little more than a ref and a via. */
export interface RecallSearchItem {
  /** How this hit is cited and re-opened. A platform-shelf ref is read back with the platform
   *  scope; a path on its own does not resolve. */
  readonly refs?: readonly string[];
  readonly title?: string | null;
  readonly match_kind?: RecallMatchKind;
  readonly subject?: "document" | "node";
  readonly shelf?: "team" | "platform";
  /** The caller's assessment. Honoured only once the original text has been read; otherwise
   *  it is capped at `author_inference` below, whatever was asserted here. */
  readonly claim_kind?: RecallClaimKind;
  readonly original_text_read?: boolean;
  readonly quote?: RecallQuote | null;
  readonly status?: RecallFindingStatus;
  readonly superseded_by?: string | null;
  /** When the source was written or approved. The claim speaks for that date and no later. */
  readonly recorded_at?: string | null;
  /** When the original text was opened, if it was. */
  readonly read_at?: string | null;
}

/** The whole input: what was asked, of what, under which budget, and what came back. */
export interface RecallSearchOutcome {
  readonly items?: readonly RecallSearchItem[];
  /** One search call, or every call the episode made. The weakest receipt governs. */
  readonly receipt: RecallSearchReceipt | readonly RecallSearchReceipt[];
  readonly question?: string | null;
  readonly scopes?: readonly string[];
  readonly budget?: RecallEpisodeBudget;
  /** The briefing, when the reasoning role has written one. Absent for the negative exits,
   *  whose sentence is authored here. */
  readonly answer?: string | null;
  /** The language that briefing is written in. Absent alongside an `answer` leaves
   *  `answer_language` null rather than claiming a language nobody declared. */
  readonly answer_language?: string | null;
  readonly unresolved_questions?: readonly string[];
}

// What comes out

export interface RecallFinding {
  readonly claim_kind: RecallClaimKind;
  readonly support: RecallSupport;
  readonly match_kind: RecallMatchKind;
  readonly refs: readonly string[];
  readonly title: string | null;
  readonly subject: "document" | "node" | null;
  readonly shelf: "team" | "platform" | null;
  readonly quote: RecallQuote | null;
  readonly status: RecallFindingStatus;
  readonly superseded_by: string | null;
  readonly recorded_at: string | null;
  readonly read_at: string | null;
}

export interface RecallResult {
  readonly answer: string;
  readonly answer_language: string | null;
  readonly result: RecallOutcome;
  readonly search_receipt_refs: readonly string[];
  readonly findings: readonly RecallFinding[];
  readonly unresolved_questions: readonly string[];
}

// The live handler's vocabulary, one way

/**
 * `via` as `knowledge_search` spells it, mapped to what the hit is worth here. `lexical-broad`
 * means no document contained all the query terms — the platform re-asked with OR and handed back
 * what matched some of them — so those rows are leads. `evidence` is the graph lane: a row reached
 * because it cites the same initiative as a strong hit, sharing no vocabulary with the query. Both
 * stay leads until original text supports them.
 *
 * DELIBERATE: the priority is a label, never a promotion. A row fused from several lanes is named
 * by the weakest claim those lanes support, and the name changes nothing about `claim_kind`, which
 * is decided by whether original text was read and by nothing else.
 */
export function matchKindFromVia(via: readonly string[]): RecallMatchKind {
  if (via.includes("lexical-broad")) return "broadened_lead";
  if (via.includes("lexical")) return "lexical";
  if (via.includes("tag")) return "tag";
  return "graph_lead";
}

// The mapping

const BLOCKER_CLAUSE: Readonly<Record<RecallBlocker, string>> = {
  service_unavailable: "the search service was unavailable",
  unknown_index_progress: "the search did not report how far it got",
  incomplete_search: "the search reported itself incomplete",
  language_unqualified: "the search was not qualified for the language the material is written in",
  unsupported_scope: "a requested scope is not supported",
  scope_not_searched: "a requested scope was not searched",
  candidates_withheld: "ranked candidates were withheld from the result",
  budget_exhausted: "the episode's budget ran out before the search finished",
};

const BLOCKER_QUESTION: Readonly<Record<RecallBlocker, string>> = {
  service_unavailable:
    "Does this team's record answer the question? The search service was unavailable, so it was never asked.",
  unknown_index_progress:
    "How much of the corpus did this search actually cover? It did not report its completeness.",
  incomplete_search: "What is in the part of the corpus this search did not reach?",
  language_unqualified:
    "Would this topic match if it were searched in the language its sources were written in?",
  unsupported_scope: "What do the unsupported scopes hold on this topic?",
  scope_not_searched: "What do the requested but unsearched scopes hold on this topic?",
  candidates_withheld: "What do the withheld candidates say? They ranked and were not returned.",
  budget_exhausted: "What would the next queries have found? The episode's budget ran out first.",
};

const BUDGET_LINES = ["queries", "pages", "reads", "elapsed_ms"] as const;

function exhausted(line: RecallBudgetLine | undefined): boolean {
  return line !== undefined
    && Number.isFinite(line.limit) && Number.isFinite(line.spent)
    && line.spent >= line.limit;
}

/** Every reason this outcome may not claim a clean empty, deduplicated and in a stable order. */
function blockersOf(
  receipts: readonly RecallSearchReceipt[],
  scopes: readonly string[],
  budget: RecallEpisodeBudget | undefined,
): RecallBlocker[] {
  const found = new Set<RecallBlocker>();
  // No receipt at all is not a clean empty. An episode that ran no search declared no progress, so
  // it may not claim that nothing matched.
  if (receipts.length === 0) found.add("unknown_index_progress");
  for (const r of receipts) {
    // A call that failed reported nothing else. Its missing completeness and missing language
    // qualification are absences of a report, not findings about the search, and the authored
    // sentence must not assert them. `continue` per receipt, so a second, partial receipt in the
    // same episode still contributes its own blockers.
    if (r.status !== "ok") { found.add("service_unavailable"); continue; }
    const completeness = r.completeness ?? "unknown";
    if (completeness === "unknown") found.add("unknown_index_progress");
    if (completeness === "partial") found.add("incomplete_search");
    if (r.language_qualified !== true) found.add("language_unqualified");
    if ((r.withheld ?? 0) > 0) found.add("candidates_withheld");
    if ((r.unsupported_scopes ?? []).length > 0) found.add("unsupported_scope");
  }
  // A requested scope no receipt accounts for is a scope nobody searched. Silence is not
  // coverage: a receipt that never said what it searched has not covered anything asked for.
  if (scopes.length > 0) {
    const searched = new Set(receipts.flatMap((r) => r.scopes_searched ?? []));
    if (scopes.some((s) => !searched.has(s))) found.add("scope_not_searched");
  }
  if (budget && BUDGET_LINES.some((k) => exhausted(budget[k]))) found.add("budget_exhausted");

  const order: readonly RecallBlocker[] = [
    "service_unavailable", "unknown_index_progress", "incomplete_search", "language_unqualified",
    "unsupported_scope", "scope_not_searched", "candidates_withheld", "budget_exhausted",
  ];
  return order.filter((b) => found.has(b));
}

/**
 * One hit, as strongly as it may honestly be claimed.
 *
 * Nothing rises above `author_inference` until the original text has been read and a quote in the
 * source's own language is in hand. A broadened or graph hit therefore stays a lead.
 */
function findingFrom(item: RecallSearchItem): RecallFinding {
  const quote = item.quote ?? null;
  const read = item.original_text_read === true && quote !== null && quote.language.length > 0;
  const subject = item.subject ?? null;
  const inferred: RecallClaimKind = subject === "node" ? "distilled_learning"
    : subject === "document" ? "stated_intent"
      : "author_inference";
  return {
    claim_kind: read ? (item.claim_kind ?? inferred) : "author_inference",
    support: read ? "original_text_read" : "lead_unconfirmed",
    match_kind: item.match_kind ?? "lexical",
    refs: item.refs ?? [],
    title: item.title ?? null,
    subject,
    shelf: item.shelf ?? null,
    quote: read ? quote : null,
    status: item.status ?? "unknown",
    superseded_by: item.superseded_by ?? null,
    recorded_at: item.recorded_at ?? null,
    read_at: item.read_at ?? null,
  };
}

function listOf(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "not declared";
}

function declaredSearch(receipts: readonly RecallSearchReceipt[], scopes: readonly string[]): string {
  const queries = receipts.map((r) => r.query).filter((q): q is string => typeof q === "string" && q.length > 0);
  return `queries: ${listOf(queries)}; scopes: ${listOf(scopes)}; searches: ${receipts.length}`;
}

/**
 * The one mapping. A search outcome in, one of the four exits out — and the sentence for the three
 * that found nothing to report, written here so they can never be collapsed into each other
 * downstream.
 *
 * Order decides it: no team beats everything, because nothing was searched. Otherwise blockers are
 * collected from every receipt, the weakest governing. Items in hand are findings regardless of
 * the blockers, which become unresolved questions instead of suppressing them. With no items,
 * blockers decide between an inconclusive retrieval and a scoped no-match.
 */
export function recallResultFrom(outcome: RecallSearchOutcome): RecallResult {
  const receipts = Array.isArray(outcome.receipt)
    ? (outcome.receipt as readonly RecallSearchReceipt[])
    : [outcome.receipt as RecallSearchReceipt];
  const items = outcome.items ?? [];
  const scopes = outcome.scopes ?? [];
  const refs = receipts.map((r) => r.ref).filter((r): r is string => typeof r === "string" && r.length > 0);
  const question = outcome.question && outcome.question.length > 0 ? outcome.question : "the topic";
  const asked = outcome.unresolved_questions ?? [];

  if (receipts.some((r) => r.status === "no_team")) {
    return {
      answer: "No team: the knowledge search is team-scoped and reported that the caller is not "
        + "acting for a team, so nothing was searched. This says nothing about what any team "
        + "has decided or recorded.",
      answer_language: "en",
      result: "no_team",
      search_receipt_refs: refs,
      findings: [],
      unresolved_questions: [...asked, `What does this team's record hold on ${question}? Nothing was searched.`],
    };
  }

  const blockers = blockersOf(receipts, scopes, outcome.budget);
  const findings = items.map(findingFrom);
  const leadQuestions = findings
    .filter((f) => f.support === "lead_unconfirmed")
    .map((f) => `Does ${f.refs.length > 0 ? f.refs.join(" + ") : f.title ?? "this hit"} actually say this? `
      + `It matched as a ${f.match_kind} and its original text was not read.`);
  const blockerQuestions = blockers.map((b) => BLOCKER_QUESTION[b]);
  const unresolved = [...asked, ...blockerQuestions, ...leadQuestions];
  const search = declaredSearch(receipts, scopes);

  if (findings.length > 0) {
    const authored = outcome.answer && outcome.answer.length > 0 ? outcome.answer : null;
    return {
      answer: authored
        ?? `${findings.length} finding(s) retrieved under the declared search (${search}). The `
        + "briefing over them is the reasoning role's to write; this is the retrieval record.",
      answer_language: authored ? (outcome.answer_language ?? null) : "en",
      result: "findings",
      search_receipt_refs: refs,
      findings,
      unresolved_questions: unresolved,
    };
  }

  if (blockers.length > 0) {
    return {
      answer: `Retrieval could not answer ${question}: ${blockers.map((b) => BLOCKER_CLAUSE[b]).join("; ")} `
        + `(${search}). This is a fact about the search, not about the team: it says nothing at `
        + "all about what was decided, and it must not be read as no prior learning.",
      answer_language: "en",
      result: "retrieval_inconclusive",
      search_receipt_refs: refs,
      findings: [],
      unresolved_questions: unresolved,
    };
  }

  return {
    answer: `No match for ${question} under the declared search (${search}). Those searches ran `
      + "to completion, in a language the index can match, with nothing withheld. That means "
      + "nothing matched THIS search — it does not mean the team never decided the topic, and "
      + "a search declared differently may still find it.",
    answer_language: "en",
    result: "no_relevant_match_in_searched_scope",
    search_receipt_refs: refs,
    findings: [],
    unresolved_questions: unresolved,
  };
}
