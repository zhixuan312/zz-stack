/**
 * PLANTING EACH FAULT THE TRIAL'S RULES CLAIM TO CATCH, AND WATCHING THE DETECTOR FIRE.
 *
 * Every rule is exercised twice: once on the healthy path, where the detector must stay SILENT,
 * and once with one specific fault planted, where it must FIRE. A negative flag that is only
 * ever read off a healthy run has been watched doing nothing, and a flag written as the literal
 * `false` would pass exactly the same observation. That is the failure this file exists for:
 * `citationFollowedHead`, `translationInOriginal`, `authorizedPinnedEffect` and
 * `supersessionReported` are all COMPUTED, and the faulted column is where that becomes a
 * measurement rather than a claim in a comment.
 *
 * THE SILENT HALF CARRIES REAL WEIGHT HERE, because almost every rule in this subject is a
 * refusal and a trial that refused everything would satisfy every faulted column while being
 * useless. So the healthy column carries what must still work: the Chinese original IS read and
 * quoted for an English asker, a graph-lane hit whose original was opened IS a conclusion, a
 * pinned read DOES authorize a pinned effect, and a superseded document IS reported as one.
 *
 * WHERE EACH FAULT LIVES. Two kinds, the same two the sibling audit probe uses. Some are
 * planted in the SUBJECT — a corpus whose original has had a rendering spliced into it, a
 * receipt that claims a language qualification the analyzer never had — and the real function
 * under test is what reports them. The rest are planted in a faulted LOCAL COPY of the
 * computation, because the rules they break are rules about what the trial MAY DO and no input
 * can make it do them: `TrialRead` is a union whose text exists only on the successful branch,
 * and `askerLanguage` has no parameter a corpus could arrive through, so "the real one cannot
 * do this" has to be shown as a comparison against a copy that can. Those copies are never
 * exported and nothing calls them but this file.
 *
 * NOTHING HERE IS A MEASUREMENT OF THE LIVE SYSTEM. The corpus is a fixture in this package and
 * `recall-trial.ts`'s header lists, by name, what that leaves unestablished.
 */
import {
  recallResultFrom,
  type RecallFinding, type RecallSearchItem, type RecallSearchReceipt,
} from "./recall.js";
import {
  citationFor, documentOf, headRevisionOf, pinnedRevisionOf, readOriginalText, searchCorpus,
  supersedeDocument, translationWasInserted, trialCorpus,
  type TrialAnalyzer, type TrialCorpus, type TrialDocument,
} from "./recall-trial-corpus.js";
import { askerLanguage, trial } from "./recall-trial.js";

/** One detector, watched on a healthy subject and on a faulted one. `fires` is true only when
 *  it stayed silent on the first and spoke on the second — either half failing makes the
 *  detector worthless, and for opposite reasons. */
export interface RecallTrialProbeRow {
  readonly detector: string;
  readonly healthy: string;
  readonly faulted: string;
  readonly fires: boolean;
}

const row = (
  detector: string,
  healthy: [boolean, string],
  faulted: [boolean, string],
): RecallTrialProbeRow => Object.freeze({
  detector,
  healthy: `${healthy[0] ? "silent" : "MISFIRED"} — ${healthy[1]}`,
  faulted: `${faulted[0] ? "fires" : "MISSED"} — ${faulted[1]}`,
  fires: healthy[0] && faulted[0],
});

// ── the fixtures these rows plant faults on ────────────────────────────────────────────────

const ZH = "doc/mig-zh";
const RENDERING = "doc/mig-en-rendering";
const UNREADABLE = "doc/mig-zh-ops";
const LEGACY = "doc/mig-legacy";
/** The text a planted supersession writes. Its only job is to differ from the revision that
 *  was cited, so that following the head is observable rather than assumed. */
const SUPERSEDED_HEAD = "SUPERSEDED HEAD: the freeze was lifted.";
const ZH_QUESTION = "这个迁移会破坏旧的模式里的迁移是什么意思";
const EN_QUESTION = "what did we decide about migration";

/** A document that vanished from the corpus would make every row below vacuous — each fault
 *  would be planted on nothing and each detector would honestly report no fault. Raising is
 *  the difference between a probe that failed and a probe that passed by having nothing to do. */
function docOrRaise(corpus: TrialCorpus, id: string): TrialDocument {
  const doc = documentOf(corpus, id);
  if (doc === null) throw new Error(`the trial corpus no longer carries ${id}`);
  return doc;
}

/** The same rule one level down, and it is the rule this probe learned the hard way: a fault
 *  planted into an empty string is not planted at all, and the row that watches for it goes
 *  green on nothing. `headRevisionOf` answers null for a document with no revision history, so
 *  every fixture setup below that needs a document's TEXT says so here rather than defaulting. */
function headTextOrRaise(corpus: TrialCorpus, id: string): string {
  const head = headRevisionOf(docOrRaise(corpus, id));
  if (head === null) throw new Error(`${id} carries no revision, so there is no text to plant`);
  return head.text;
}

/** GENERIC over the finding type, so a row that needs what the TRIAL observed about a hit —
 *  its read failure, its rendering — keeps it instead of widening to the base finding. */
function findingFor<T extends RecallFinding>(findings: readonly T[], id: string): T | null {
  return findings.find((f) => (f.refs[0] ?? "").startsWith(id)) ?? null;
}

const RECEIPT: RecallSearchReceipt = Object.freeze({
  status: "ok", ref: "probe-receipt-1", query: "probe",
  completeness: "complete_for_declared_search", language_qualified: true,
  withheld: 0, scopes_searched: ["team"],
});

// ── the faulted local copies ───────────────────────────────────────────────────────────────

/** THE FAULT THE REAL `askerLanguage` CANNOT HAVE: a signature through which the corpus can
 *  reach it. Written out in full because it is worth seeing how short it is — one line, and it
 *  is right for every monolingual corpus anybody would build while testing. */
function corpusLanguage(findings: readonly RecallFinding[]): string {
  return findings[0]?.quote?.language ?? "en";
}

/** THE FAULT THE REAL `itemFrom` CANNOT HAVE: a quotation built from something other than a
 *  successful read. `TrialRead`'s `text` exists only on the `ok` branch, so no rearrangement of
 *  the real path reaches this shape; this copy takes the text as an argument and asserts the
 *  read beside it. Two fields, and that is the entire distance between a lead and a conclusion. */
function quoteWithoutReading(
  doc: TrialDocument, text: string, language: string, via: readonly string[],
): RecallSearchItem {
  return {
    refs: [`${doc.id}@r1`], title: doc.title, subject: doc.subject, shelf: doc.shelf,
    match_kind: via.includes("evidence") ? "graph_lead" : "lexical",
    claim_kind: doc.claim_kind,
    original_text_read: true,
    quote: { text, language },
  };
}

/** THE FAULT THE REAL `readOriginalText` CANNOT HAVE: dropping the revision from the citation
 *  and answering with whatever the document says now. It reads as freshness — the caller asked
 *  about that document, this is that document — and what it changes is the sentence somebody
 *  else already cited. */
function resolveIgnoringRevision(corpus: TrialCorpus, ref: string): string | null {
  const doc = documentOf(corpus, ref.split("@")[0]);
  return doc === null ? null : headRevisionOf(doc)?.text ?? null;
}

/** THE FAULT THE REAL `authorizes` CANNOT HAVE: taking a successful read as sufficient, with no
 *  question about WHAT was read. Under a current-path episode every read succeeds — against the
 *  head — so this authorizes a pinned effect from a lead that never saw the pinned revision. */
function authorizeFromCurrentPath(findings: readonly RecallFinding[]): boolean {
  return findings.some((f) => f.support === "original_text_read");
}

/** THE FAULT NOTHING IN THE TRIAL DOES: writing the rendering into the original. It is what
 *  "keep the record in one language" looks like when somebody tidies, and afterwards there is
 *  no copy of the document that is only what its author wrote. */
function spliceRenderingIntoOriginal(corpus: TrialCorpus): void {
  const original = docOrRaise(corpus, ZH);
  const rendered = headTextOrRaise(corpus, RENDERING);
  original.revisions = original.revisions.map((r) => ({ ...r, text: `${r.text} ${rendered}` }));
}

/** THE TOKENIZER THE ANALYSIS EXISTS TO REPLACE: whitespace, which is what a prose text-search
 *  configuration does to an unspaced Han run. Not a strawman — `TEXT_SEARCH_CONFIG` pins
 *  `{ latin: "english", han: "simple" }` precisely because this is the live behaviour, and the
 *  whole of the Chinese question comes back as one token under it. */
const tokenizeOnWhitespace: TrialAnalyzer = (text) =>
  text.toLowerCase().split(/\s+/).filter((t) => t.length > 0);

// ── the detectors ──────────────────────────────────────────────────────────────────────────

function answerLanguageComesFromTheAsker(): RecallTrialProbeRow {
  const en = trial(EN_QUESTION);
  const zh = trial(ZH_QUESTION);
  const inherited = corpusLanguage(en.findings);
  return row(
    "the answer's language is derived from the question, not from whichever document matched",
    [en.answer_language === "en" && zh.answer_language === "zh"
      && en.findings[0]?.quote?.language === "zh"
      && askerLanguage(EN_QUESTION) === "en",
     "the English question is answered in English although its strongest finding is quoted in "
     + "zh, and the Chinese question is answered in zh"],
    [inherited !== "en",
     `reading the language off the findings answers the English asker in ${inherited}, because `
     + "the document that actually holds the decision was never written in their language"],
  );
}

function hanQueriesAreSegmentedBeforeTheIndexIsAsked(): RecallTrialProbeRow {
  const real = trial(ZH_QUESTION);
  const blind = trial(ZH_QUESTION, { analyzer: tokenizeOnWhitespace });
  const tokens = tokenizeOnWhitespace(ZH_QUESTION);
  return row(
    "the Chinese question is segmented, and an unsegmented search says it could not answer",
    [real.result === "findings" && real.findings.length > 0,
     `the Han-aware analysis reaches ${real.findings.length} finding(s) in the same corpus`],
    [blind.findings.length === 0 && blind.result === "retrieval_inconclusive" && tokens.length === 1,
     `a whitespace tokenizer makes the whole question ${tokens.length} token, matches nothing, `
     + `and the episode reports ${blind.result} rather than a clean empty`],
  );
}

function anUnsegmentedSearchMayNotClaimACleanEmpty(): RecallTrialProbeRow {
  const honest = trial(ZH_QUESTION, { analyzer: tokenizeOnWhitespace });
  // The fault is in the RECEIPT, not the search: the same zero items, declared as having been
  // asked in a language the index could match.
  const flattering = recallResultFrom({
    items: [], receipt: { ...RECEIPT, query: ZH_QUESTION }, question: ZH_QUESTION,
    scopes: ["team"],
  });
  return row(
    "a search that could not match the material's language may not report that nothing matched",
    [honest.result === "retrieval_inconclusive",
     "an honest receipt reports the language qualification it did not have, and the episode "
     + "comes back inconclusive"],
    [flattering.result === "no_relevant_match_in_searched_scope",
     "declaring the same zero results language-qualified turns them into "
     + `${flattering.result} — a decision that is on the record read back as one nobody took`],
  );
}

function aPinnedCitationDoesNotFollowTheHead(): RecallTrialProbeRow {
  const real = trial("migration", { thenSupersede: true });
  const cited = real.findings[0];
  const corpus = trialCorpus();
  const doc = docOrRaise(corpus, ZH);
  const ref = citationFor(doc, "pinned_revision");
  const before = readOriginalText(corpus, ref);
  // The answer is taken, not discarded: a setup that silently did nothing would leave both
  // columns below reading exactly as they do when the rule holds.
  const applied = supersedeDocument(corpus, ZH, SUPERSEDED_HEAD);
  const after = resolveIgnoringRevision(corpus, ref);
  const honest = readOriginalText(corpus, ref);
  return row(
    "superseding a document does not redirect the citation somebody already made",
    [real.citationFollowedHead === false && honest.ok && before.ok && honest.text === before.text
      && cited?.refs[0] === ref && pinnedRevisionOf(ref) === "r1" && applied === `${ZH}@r2`,
     `${ref} still resolves to the text it named after the document moved to ${applied}, and `
     + "the finding still carries that citation"],
    [after !== null && before.ok && after !== before.text,
     "a resolver that drops the revision answers the same citation with the new head, so the "
     + "reader following an old reference lands on a document its author never wrote"],
  );
}

function supersessionIsReportedRatherThanApplied(): RecallTrialProbeRow {
  const quiet = trial("migration");
  const moved = trial("migration", { thenSupersede: true });
  const reported = moved.findings.find((f) => f.status === "superseded");
  return row(
    "a superseded original is reported to the reader",
    [quiet.supersessionReported === false
      && quiet.findings.every((f) => f.superseded_by === null),
     "nothing is reported superseded while nothing has been superseded, so the flag is read "
     + "off the corpus rather than written"],
    [moved.supersessionReported && reported?.superseded_by !== null
      && reported?.superseded_by !== undefined,
     `the walk finds the head has moved and names it: ${reported?.superseded_by}, beside the `
     + "citation and the quotation, which are unchanged"],
  );
}

function onlyAPinnedReadAuthorizesAPinnedEffect(): RecallTrialProbeRow {
  const pinned = trial("migration");
  const lead = trial("migration", { assurance: "current_path" });
  const legacy = pinned.findings.find((f) => (f.refs[0] ?? "") === "doc/mig-legacy");
  return row(
    "a pinned effect is authorized only by reading the revision the citation names",
    [pinned.authorizedPinnedEffect && lead.authorizedPinnedEffect === false
      && legacy?.support === "original_text_read",
     "a pinned read authorizes; a current-path episode authorizes nothing; and the imported "
     + "runbook, readable and quotable and carrying no revision history, authorizes nothing "
     + "even under a pinned episode"],
    [authorizeFromCurrentPath(lead.findings),
     "taking a successful read as sufficient authorizes a pinned effect from an episode that "
     + "only ever saw the head, where the real path refuses"],
  );
}

function aTranslationIsNeverWrittenIntoTheOriginal(): RecallTrialProbeRow {
  const real = trial(EN_QUESTION);
  const clean = trialCorpus();
  const spliced = trialCorpus();
  spliceRenderingIntoOriginal(spliced);
  return row(
    "the original document still reads as its author wrote it",
    [real.findings.every((f) => !f.translationInOriginal)
      && translationWasInserted(clean, ZH) === false,
     "a trial that produced an English rendering for an English asker left every original "
     + "revision byte-identical to the snapshot taken before it ran"],
    [translationWasInserted(spliced, ZH),
     "appending the rendering to the original revision is detected, and after it there is no "
     + "copy of that document that is only what its author wrote"],
  );
}

function aTranslationNeverSuppliesTheOriginalQuotation(): RecallTrialProbeRow {
  const real = trial(EN_QUESTION);
  const corpus = trialCorpus();
  const original = docOrRaise(corpus, ZH);
  const rendered = headTextOrRaise(corpus, RENDERING);
  const faulted = recallResultFrom({
    items: [quoteWithoutReading(original, rendered, "en", ["lexical"])], receipt: RECEIPT,
  });
  const top = real.findings[0];
  const renderingFinding = findingFor(real.findings, RENDERING);
  return row(
    "the rendering is labelled beside the quotation and never becomes it",
    [top?.quote?.language === "zh" && top?.rendering?.kind === "translation"
      && renderingFinding?.quote === null && renderingFinding?.support === "lead_unconfirmed",
     "the English asker gets the Chinese sentence as the quotation with the rendering labelled "
     + "beside it, and the rendering's own row is a lead with its read failure"],
    [faulted.findings[0]?.quote?.language === "en"
      && faulted.findings[0]?.claim_kind === "approved_decision",
     "quoting the rendering under the original's citation presents a document written in zh as "
     + `an ${faulted.findings[0]?.claim_kind} quoted in en, which is the version an English `
     + "reader would never think to question"],
  );
}

function observedResultsRequireASuccessfulRead(): RecallTrialProbeRow {
  const real = trial(ZH_QUESTION);
  const unread = findingFor(real.findings, UNREADABLE);
  const corpus = trialCorpus();
  const doc = docOrRaise(corpus, UNREADABLE);
  const excerpt = searchCorpus(corpus, ZH_QUESTION).hits
    .find((h) => h.doc_id === UNREADABLE)?.excerpt ?? "";
  const faulted = recallResultFrom({
    items: [quoteWithoutReading(doc, excerpt, "zh", ["lexical"])], receipt: RECEIPT,
  });
  return row(
    "a document asserting an observed result is not one until its original has been opened",
    [unread?.claim_kind === "author_inference" && unread?.support === "lead_unconfirmed"
      && unread?.readOriginal === false && unread?.readFailure !== null
      && doc.claim_kind === "observed_result",
     `the document asserts ${doc.claim_kind}, its body cannot be retrieved, and the episode `
     + `reports ${unread?.claim_kind} carrying the read failure`],
    [faulted.findings[0]?.claim_kind === "observed_result"
      && faulted.findings[0]?.support === "original_text_read",
     `building the quotation from the search row's excerpt — ${excerpt.slice(0, 10)}… — and `
     + "asserting the read beside it promotes the same unopened document to an observed result"],
  );
}

function aLeadBecomesAConclusionOnlyByBeingRead(): RecallTrialProbeRow {
  const real = trial(EN_QUESTION);
  const viaGraph = findingFor(real.findings, ZH);
  const renderingFinding = findingFor(real.findings, RENDERING);
  const corpus = trialCorpus();
  const rendering = docOrRaise(corpus, RENDERING);
  const excerpt = searchCorpus(corpus, EN_QUESTION).hits
    .find((h) => h.doc_id === RENDERING)?.excerpt ?? "";
  const faulted = recallResultFrom({
    items: [quoteWithoutReading(rendering, excerpt, "en", ["evidence"])], receipt: RECEIPT,
  });
  return row(
    "the lane names the hit and never promotes it",
    [viaGraph?.match_kind === "graph_lead" && viaGraph?.support === "original_text_read"
      && renderingFinding?.support === "lead_unconfirmed",
     "the document reached through a relation is still called a graph_lead after its original "
     + "was opened, and the one whose original was refused is still a lead"],
    [faulted.findings[0]?.support === "original_text_read"
      && faulted.findings[0]?.match_kind === "graph_lead",
     "asserting the read on the same relation-reached row makes a graph_lead a conclusion with "
     + "nothing opened — the lane label unchanged, and now saying nothing"],
  );
}

function aSupersessionThatDidNotHappenIsRefused(): RecallTrialProbeRow {
  const corpus = trialCorpus();
  const applied = supersedeDocument(corpus, ZH, SUPERSEDED_HEAD);
  const moved = trial("migration", { thenSupersede: true });

  // THE FAILURE IS REACHABLE THROUGH THE PUBLIC SURFACE, not through an id nobody would type.
  // The imported runbook carries no revision history, so it has no head to move — and it is
  // the strongest finding for its own name, so an episode asked to supersede after searching
  // for it lands on a `supersedeDocument` that can only answer null.
  const unmoved = trialCorpus();
  const missed = supersedeDocument(unmoved, LEGACY, SUPERSEDED_HEAD);
  const head = headRevisionOf(docOrRaise(unmoved, LEGACY));
  let raised: string | null = null;
  try {
    trial("legacy", { thenSupersede: true });
  } catch (err) {
    raised = err instanceof Error ? err.message : String(err);
  }
  // AND THIS IS WHY THE ANSWER CANNOT BE DISCARDED. These are the two flags an episode that
  // shrugged at that null would have reported, taken from a run that asked for no supersession
  // at all — the same values, indistinguishable from the case where the citation genuinely
  // held against a head that genuinely moved. The guard's answer is the only thing that tells
  // the two apart.
  const neverAsked = trial("legacy");

  return row(
    "an episode refuses to report a supersession it failed to arrange",
    [applied === `${ZH}@r2` && moved.supersessionReported
      && headRevisionOf(docOrRaise(corpus, ZH))?.id === "r2",
     `superseding the Chinese original answers ${applied}, the head moves to it, and the `
     + "episode reports the supersession to the reader"],
    [missed === null && head === null && raised !== null
      && neverAsked.citationFollowedHead === false && neverAsked.supersessionReported === false,
     `the imported runbook has no revision to move, so the call answers ${missed} and the `
     + `episode raises instead of walking it — it must, because an episode that discarded that `
     + `answer would report citationFollowedHead=${neverAsked.citationFollowedHead} and `
     + `supersessionReported=${neverAsked.supersessionReported}, which is exactly what a run `
     + "that asked for no supersession reports, and exactly what a citation that genuinely "
     + "held would report too"],
  );
}

/** Every detector in this module, each watched twice. A row whose `fires` is false is a finding
 *  about this module and not about its subject. */
export function recallTrialProbe(): readonly RecallTrialProbeRow[] {
  return Object.freeze([
    answerLanguageComesFromTheAsker(),
    hanQueriesAreSegmentedBeforeTheIndexIsAsked(),
    anUnsegmentedSearchMayNotClaimACleanEmpty(),
    aPinnedCitationDoesNotFollowTheHead(),
    supersessionIsReportedRatherThanApplied(),
    onlyAPinnedReadAuthorizesAPinnedEffect(),
    aTranslationIsNeverWrittenIntoTheOriginal(),
    aTranslationNeverSuppliesTheOriginalQuotation(),
    observedResultsRequireASuccessfulRead(),
    aLeadBecomesAConclusionOnlyByBeingRead(),
    aSupersessionThatDidNotHappenIsRefused(),
  ]);
}
