/**
 * One recall episode, end to end: a public search, a pinned read of the original, a walk of the
 * source and supersession relations, and a `RecallResult` in the language the asker used.
 *
 * `recall.ts` maps a search outcome to one of four exits and caps a claim with no original text
 * behind it; `recall-trial-corpus.ts` holds the corpus and a Han-aware analysis. Neither says what an
 * episode does between the first query and the answer: which hit may be quoted, which citation the
 * reader is handed after the document moves, which lead may authorize an effect, and which language
 * the answer comes back in. `trial` below is that path, run once per question.
 *
 * The corpus is declared in this package, because `@zz/contracts` sits underneath the services and
 * cannot import `services/zz-core/src/tenant-info/search.ts`. So nothing here is evidence about the
 * live `knowledge_search` handler and its lanes, BM25 scoring or RRF fusion; `serializeResults` and
 * its response budget; the query grammar, its phrases, exclusions or cursors; whether `pg_textsearch`
 * and `pg_trgm` exist on any cluster; the real supersession operation; or team scoping and the
 * `no_team` exit. What it is evidence about is the traversal rules.
 *
 * The answer's language comes from the question. `askerLanguage` takes the question and nothing else,
 * so no implementation can inherit a language from the material that matched; the corpus is arranged
 * so the strongest answer to the English question is a Chinese document.
 */
import {
  citationFor, documentIdOf, documentOf, headRevisionOf, pinnedRevisionOf, readOriginalText,
  searchCorpus, supersedeDocument, translationWasInserted, trialCorpus,
  type TrialAnalyzer, type TrialAssurance, type TrialCorpus, type TrialDocument,
  type TrialLanguage, type TrialRead,
} from "./recall-trial-corpus.js";
import {
  matchKindFromVia, recallResultFrom,
  type RecallClaimKind, type RecallFinding, type RecallResult, type RecallSearchItem,
  type RecallSearchReceipt,
} from "./recall.js";

/** Whether a quotation is the source's own words or a rendering of them, said in the finding
 *  rather than left to the reader. A rendering never replaces `quote`; it sits beside it. */
interface TrialRendering {
  readonly kind: "translation" | "explanation";
  readonly text: string;
  readonly language: TrialLanguage;
  /** The document the rendering was taken from. A rendering the trial made up would have none,
   *  and the trial makes none up: where no rendering is on record it says so instead. */
  readonly source_ref: string | null;
}

/**
 * A `RecallFinding` with what the traversal observed about it. `claim_kind`, `support`, `match_kind`,
 * `refs`, `quote` and `status` keep the meanings `recall.ts` gives them.
 *
 * `original_quote` and `readOriginal` are assigned from the inherited fields, never computed again:
 * `original_quote` is the same object `quote` holds and `readOriginal` is
 * `support === "original_text_read"`, so `claim_kind === "observed_result"` with `readOriginal` false
 * is unrepresentable.
 */
interface TrialFinding extends RecallFinding {
  readonly original_quote: RecallFinding["quote"];
  readonly readOriginal: boolean;
  readonly translationInOriginal: boolean;
  readonly rendering: TrialRendering | null;
  /** Why the original could not be opened, when it could not. A finding with one of these is a
   *  lead carrying its read failure, and `recall.ts` has already capped its claim. */
  readonly readFailure: string | null;
  readonly authorizesPinnedEffect: boolean;
}

interface TrialResult extends RecallResult {
  readonly findings: readonly TrialFinding[];
  /** True if superseding the cited document moved the reader off the revision they cited. */
  readonly citationFollowedHead: boolean;
  readonly supersessionReported: boolean;
  readonly authorizedPinnedEffect: boolean;
}

interface TrialOptions {
  /** Supersede the document behind the strongest finding after it has been read and cited,
   *  then walk the supersession relation and report what the walk found. */
  readonly thenSupersede?: boolean;
  /** What the episode may address. `current_path` is a legacy lead: the head is reachable and
   *  the revision somebody cited is not. */
  readonly assurance?: TrialAssurance;
  /** The analysis the search runs on. Injectable so the probe can hand it one that cannot
   *  segment an unspaced Han run and watch the search go silent. */
  readonly analyzer?: TrialAnalyzer;
}

// Deriving the answer's language from the question, and from nothing else

/**
 * The language the asker asked in. One parameter, the question — no corpus, no hit and no finding in
 * this signature, so no implementation of it can inherit a language from the material that matched.
 */
export function askerLanguage(question: string): TrialLanguage {
  return /\p{Script=Han}/u.test(question) ? "zh" : "en";
}

// Ranking: what answers a question about a decision

/**
 * How strongly a claim answers "what did we decide". Not `RecallClaimKind`'s declaration order, which
 * orders by how strongly a claim is supported — an approved decision and a stated intent sit next to
 * each other there. A proposal saying "nothing is decided yet" must not be handed back as the
 * decision.
 */
const ANSWERS_A_DECISION: Readonly<Record<RecallClaimKind, number>> = {
  approved_decision: 5,
  observed_result: 4,
  reported_result: 3,
  distilled_learning: 2,
  stated_intent: 1,
  author_inference: 0,
};

/** One hit, with everything the episode learned by opening it. */
interface Candidate {
  readonly doc: TrialDocument;
  readonly ref: string;
  readonly read: TrialRead;
  readonly via: readonly string[];
  readonly excerpt: string;
}

/**
 * Conclusions before leads, then by how well the claim answers a question about a decision, then by
 * recency. `read.ok` is the same boolean `recall.ts` demotes on, so ranking by it cannot disagree
 * with the claim the finding ends up carrying; ranking on an unread hit's asserted `claim_kind` would
 * put the loudest unverified document first.
 */
function rank(candidates: readonly Candidate[]): readonly Candidate[] {
  const strength = (c: Candidate): number =>
    ANSWERS_A_DECISION[c.read.ok ? c.doc.claim_kind : "author_inference"];
  const recorded = (c: Candidate): string => {
    const head = headRevisionOf(c.doc);
    // DELIBERATE: a document with no revision history is still rankable and not refused here — it is
    // readable through its current path, quotable, and a real finding. What it cannot do is say when
    // it was written, so it sorts oldest. Recency is the last tiebreak, after read-ness and after how
    // well the claim answers the question.
    return head === null ? "" : head.recorded_at;
  };
  return [...candidates].sort((a, b) =>
    Number(b.read.ok) - Number(a.read.ok)
    || strength(b) - strength(a)
    || (recorded(b) < recorded(a) ? -1 : recorded(b) > recorded(a) ? 1 : 0)
    || (a.doc.id < b.doc.id ? -1 : 1));
}

// The episode

const READ_AT = "2026-09-21T00:00:00.000Z";
const RECEIPT_REF = "trial-search-1";
const SCOPES: readonly string[] = ["team"];

/**
 * The one place a quote is built, from the union's `ok` branch. `text` and `language` do not exist on
 * the failed branch, so no rearrangement can produce a quote for an original nobody opened, and
 * `original_text_read` is the same `read.ok`.
 */
function itemFrom(candidate: Candidate): RecallSearchItem {
  const { doc, ref, read, via } = candidate;
  const head = headRevisionOf(doc);
  const movedOn = head !== null && pinnedRevisionOf(ref) !== null && head.id !== pinnedRevisionOf(ref);
  return {
    refs: [ref],
    title: doc.title,
    match_kind: matchKindFromVia(via),
    subject: doc.subject,
    shelf: doc.shelf,
    claim_kind: doc.claim_kind,
    original_text_read: read.ok,
    quote: read.ok ? { text: read.text, language: read.language } : null,
    // A document nobody opened has no currency either: asserting `adopted` for a hit whose original
    // was refused or unretrievable is the promotion the claim rule exists to stop, which is why
    // `recall.ts` defaults an absent status to `unknown`. Supersession stays reportable for a lead —
    // the head fetch is metadata about where the document went, not a read of what it says.
    status: movedOn ? "superseded" : read.ok ? "adopted" : "unknown",
    superseded_by: movedOn ? (doc.superseded_by ?? `${doc.id}@${head.id}`) : null,
    recorded_at: read.ok ? (doc.revisions.find((r) => r.id === read.revision)?.recorded_at ?? null) : null,
    read_at: read.ok ? READ_AT : null,
  };
}

/** The rendering that belongs beside a foreign-language quotation, when one is on record. A
 *  rendering is never invented and never written back: this only looks one up. */
function renderingFor(
  corpus: TrialCorpus, doc: TrialDocument, quoteLanguage: TrialLanguage | null,
  asker: TrialLanguage,
): TrialRendering | null {
  if (quoteLanguage === null || quoteLanguage === asker) return null;
  const rendering = corpus.documents.find((d) =>
    d.translation_of === doc.id && d.head_language === asker);
  const revision = rendering === undefined ? null : headRevisionOf(rendering);
  if (rendering === undefined || revision === null) return null;
  return { kind: "translation", text: revision.text, language: asker,
           source_ref: `${rendering.id}@${revision.id}` };
}

/** Whether a finding may authorize an effect against a pinned revision: the citation names a
 *  revision, the original behind it was opened, and what was opened is that revision. A
 *  current-path lead fails the first clause and a failed read fails the second. */
function authorizes(candidate: Candidate): boolean {
  const pinned = pinnedRevisionOf(candidate.ref);
  return pinned !== null && candidate.read.ok && candidate.read.revision === pinned;
}

/**
 * Whether the reader was moved off the revision they cited. Measured by re-opening the citation after
 * the document has been superseded, not by trusting that the resolver was written to honour it. Only
 * meaningful where the head has actually moved.
 */
function citationFollowsHead(corpus: TrialCorpus, findings: readonly RecallFinding[]): boolean {
  return findings.some((f) => {
    const ref = f.refs[0];
    if (ref === undefined) return false;
    const pinned = pinnedRevisionOf(ref);
    const doc = documentOf(corpus, documentIdOf(ref));
    const head = doc === null ? null : headRevisionOf(doc);
    if (pinned === null || head === null || head.id === pinned) return false;
    const reread = readOriginalText(corpus, ref);
    if (!reread.ok) return false;
    return reread.revision === head.id || (f.quote !== null && f.quote.text === head.text);
  });
}

/** The text a supersession writes. Its only job is to differ from the revision that was cited,
 *  so that following the head is observable rather than assumed. */
const SUPERSEDING_TEXT = "SUPERSEDED HEAD: the freeze was lifted and the cutover now runs online.";

/** The three things the answer sentence reads off a ranked candidate. Its own shape, so the
 *  sentence is written from what the episode observed — `read.ok` and nothing else deciding
 *  whether a row is a lead — rather than from a finding that does not exist yet. */
interface AnswerRow {
  readonly title: string;
  readonly ref: string;
  readonly quoteLanguage: TrialLanguage | null;
  readonly isLead: boolean;
}

/**
 * The answer sentence, in the asker's language. The Chinese template is output data: a `RecallResult`
 * whose `answer_language` says `zh` over English prose would be a false statement about its own
 * contents. Every comment, identifier and diagnostic in this package stays English.
 */
function answerIn(
  language: TrialLanguage, question: string, rows: readonly AnswerRow[],
): string {
  const top = rows[0];
  const leads = rows.filter((r) => r.isLead).length;
  if (top === undefined) {
    return language === "zh"
      ? `没有 finding 可以回答「${question}」。`
      : `No finding answers "${question}".`;
  }
  const quoted = top.quoteLanguage ?? "none";
  if (language === "zh") {
    return `用中文回答「${question}」：最强的 finding 是 ${top.title}，引用 ${top.ref}，`
      + `引文保持原文语言（${quoted}），译文单独标注、不写回原文。`
      + `共 ${rows.length} 条 finding，其中 ${leads} 条仍是 lead。`;
  }
  return `Answering in English: the strongest finding for "${question}" is ${top.title}, cited `
    + `at ${top.ref} and quoted in its own language (${quoted}). Any rendering beside that `
    + `quotation is labelled a translation and is not part of the document. ${rows.length} `
    + `finding(s), ${leads} still a lead.`;
}

/**
 * One trial: ask, search, read, walk, answer.
 *
 * The order is the contract. The citation is formed from the head as it stood when the episode read
 * it, before any supersession; the head is fetched afterwards only to check whether the document has
 * moved, producing a `status` and a `superseded_by` beside the citation — never a new citation and
 * never a new quotation.
 */
export function trial(query: string, options: TrialOptions = {}): TrialResult {
  const corpus = trialCorpus();
  const assurance: TrialAssurance = options.assurance ?? "pinned_revision";
  const asker = askerLanguage(query);
  const search = searchCorpus(corpus, query, options.analyzer);

  const candidates: Candidate[] = [];
  for (const hit of search.hits) {
    const doc = documentOf(corpus, hit.doc_id);
    if (doc === null) continue;
    const ref = citationFor(doc, assurance);
    candidates.push({ doc, ref, read: readOriginalText(corpus, ref), via: hit.via, excerpt: hit.excerpt });
  }
  const ranked = rank(candidates);

  // The head is fetched only after the strongest finding has been cited and quoted, so that
  // what supersession can do to this episode is limited to being reported by the walk below.
  if (options.thenSupersede === true && ranked.length > 0) {
    const applied = supersedeDocument(corpus, ranked[0].doc.id, SUPERSEDING_TEXT);
    // A supersession that did not happen makes the walk below meaningless in the flattering
    // direction, so the answer is taken rather than discarded. `supersedeDocument` answers null when
    // the document has no head to move, which is reachable through this function's own surface.
    // Shrugging at it would report `supersessionReported: false` and `citationFollowedHead: false` —
    // both true, and true because there was never a head to follow rather than because the citation
    // held.
    if (applied === null) {
      throw new Error(`this episode was asked to supersede ${ranked[0].doc.id} and nothing was `
        + "superseded: that document carries no revision to move. Any supersession reported "
        + "from here would be a fact about the setup and not about the record");
    }
  }

  const readFailures = ranked
    .filter((c) => !c.read.ok)
    .map((c) => `Does ${c.ref} support this? Its original text was not read: `
      + `${c.read.ok ? "" : c.read.failure}`);
  const missingRenderings = ranked
    .filter((c) => c.read.ok && c.read.language !== asker
      && renderingFor(corpus, c.doc, c.read.language, asker) === null)
    .map((c) => `What does ${c.ref} say in ${asker}? No rendering of it is on record, and a `
      + "translation is not written to fill the gap.");

  const receipt: RecallSearchReceipt = {
    status: "ok",
    ref: RECEIPT_REF,
    query,
    completeness: "complete_for_declared_search",
    language_qualified: search.language_qualified,
    withheld: search.withheld,
    scopes_searched: SCOPES,
    filters: { assurance },
  };
  const items = ranked.map(itemFrom);
  const base = recallResultFrom({
    items,
    receipt,
    question: query,
    scopes: SCOPES,
    answer: answerIn(asker, query, ranked.map((c) => ({
      title: c.doc.title,
      ref: c.ref,
      quoteLanguage: c.read.ok ? c.read.language : null,
      isLead: !c.read.ok,
    }))),
    answer_language: asker,
    unresolved_questions: [...readFailures, ...missingRenderings],
  });

  const findings: TrialFinding[] = base.findings.map((f, index) => {
    const candidate = ranked[index];
    return {
      ...f,
      original_quote: f.quote,
      readOriginal: f.support === "original_text_read",
      translationInOriginal: translationWasInserted(corpus, documentIdOf(f.refs[0] ?? "")),
      rendering: renderingFor(
        corpus, candidate.doc, candidate.read.ok ? candidate.read.language : null, asker),
      readFailure: candidate.read.ok ? null : candidate.read.failure,
      authorizesPinnedEffect: authorizes(candidate),
    };
  });

  return {
    ...base,
    findings,
    citationFollowedHead: citationFollowsHead(corpus, findings),
    supersessionReported: findings.some((f) => f.status === "superseded" && f.superseded_by !== null),
    authorizedPinnedEffect: findings.some((f) => f.authorizesPinnedEffect),
  };
}
