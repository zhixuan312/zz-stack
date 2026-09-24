/**
 * The corpus the trial searches, and the analysis it is searched with.
 *
 * A fixture, not the live handler: `@zz/contracts` sits underneath the services, so
 * `services/zz-core/src/tenant-info/search.ts` cannot be reached from here. What the corpus
 * establishes is that the traversal rules hold — a lead is not a conclusion, a pinned citation
 * does not follow the head, a translation is not an original, an answer is written in the
 * asker's language. It establishes nothing about the live index; `recall-trial.ts`'s header
 * lists what that leaves open.
 *
 * Each document makes one rule expensive:
 *
 *   doc/mig-zh          the old Chinese decision, with no Latin word at all, so an English
 *                       asker reaches it only through a relation — and the strongest answer to
 *                       an English question is therefore quoted in Chinese.
 *   doc/mig-en-rendering  an English translation of it, registered as one. Where an English
 *                       lexical search lands, and the read of it fails by name.
 *   doc/mig-en-control  a genuine English document matching every word of the English question
 *                       and saying "nothing is decided yet".
 *   doc/mig-zh-ops      a Chinese document asserting an observed result whose stored body
 *                       cannot be retrieved.
 *   doc/schema-note     a Chinese node sharing exactly one bigram with the question.
 *   doc/mig-legacy      an imported runbook with no revision history, only a current path.
 *
 * The analysis is Han-aware. `packages/indexing`'s `TEXT_SEARCH_CONFIG` pins
 * `{ latin: "english", han: "simple" }` because a prose tokenizer cannot segment an unspaced
 * Han run, so `trialAnalyze` emits Han unigrams and adjacent Han bigrams the way
 * `zz-lexical-v2` does, and `searchCorpus` takes its analyzer as a parameter so the probe can
 * substitute the broken one. DELIBERATE: `@zz/indexing` is not imported for it — this package
 * has one dependency, and adding a workspace package to borrow a regex would invert the build.
 *
 * Stemming is not reimplemented: `latinMatches` is a prefix comparison standing in for the
 * `english` configuration's stemmer.
 */
import type { RecallClaimKind } from "./recall.js";

/** The two languages this corpus is written in. A wider set would be fixture decoration. */
export type TrialLanguage = "zh" | "en";

/** Whether an episode may address a historical revision, or only the current path. A legacy
 *  lead reached on the current path alone knows the head and nothing about what was cited. */
export type TrialAssurance = "pinned_revision" | "current_path";

interface TrialRevision {
  readonly id: string;
  readonly text: string;
  readonly language: TrialLanguage;
  readonly recorded_at: string;
}

export interface TrialDocument {
  readonly id: string;
  readonly title: string;
  readonly subject: "document" | "node";
  readonly shelf: "team" | "platform";
  /** Mutable, and the one mutable thing in the corpus: superseding a document appends a
   *  revision. Nothing in this module rewrites an existing entry, which is what lets
   *  `translationWasInserted` compare the originals against the snapshot taken at build. */
  revisions: TrialRevision[];
  /** The current path for a document imported with no revision history at all. */
  readonly head_text: string | null;
  readonly head_language: TrialLanguage;
  /** What the document asserts about itself. An assertion, never a grant: nothing here is
   *  honoured until the original text behind it has been read. */
  readonly claim_kind: RecallClaimKind;
  /** The document this one renders into another language, when it is a rendering. */
  readonly translation_of: string | null;
  readonly readable: boolean;
  readonly read_failure: string | null;
  /** Set by `supersedeDocument`, and reported rather than applied. */
  superseded_by: string | null;
}

export interface TrialCorpus {
  readonly documents: readonly TrialDocument[];
  /** Every revision text as it stood when the corpus was built, keyed by document then
   *  revision. The baseline `translationWasInserted` compares against — a revision that exists
   *  here and reads differently now has been rewritten, and that is the fault. */
  readonly pristine: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

// The analysis

const HAN = /\p{Script=Han}/u;
const LATIN_RUN = /[a-z0-9_]+/g;

/** Words that say how a question is asked rather than what it is about. Small and explicit:
 *  a long list would start deciding which documents match, which is the fixture's job. */
const CARRIES_NO_TOPIC: ReadonlySet<string> = new Set([
  "what", "did", "we", "do", "does", "about", "the", "a", "an", "of", "is", "are", "was", "were",
  "to", "and", "so", "in", "on", "for", "our", "this", "that", "it", "be", "by", "from", "with",
  "then", "there", "here", "yet", "new", "old", "will", "would", "have", "has", "had", "at",
]);

function isHanScalar(scalar: string): boolean {
  return HAN.test(scalar);
}

/** Every maximal run of adjacent Han scalars in a string. The runs are what a prose tokenizer
 *  cannot segment, and `languageQualified` below asks whether the analyzer segmented them. */
function hanRuns(text: string): readonly string[] {
  const runs: string[] = [];
  let current = "";
  for (const scalar of Array.from(text)) {
    if (isHanScalar(scalar)) current += scalar;
    else if (current.length > 0) { runs.push(current); current = ""; }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/** The content words of a Latin stretch, lowercased, with the question-shaped ones dropped. */
function latinWords(text: string): readonly string[] {
  const words = text.toLowerCase().match(LATIN_RUN) ?? [];
  return words.filter((w) => !CARRIES_NO_TOPIC.has(w));
}

/**
 * `zz-lexical-v2`'s shape: Han unigrams, overlapping adjacent Han bigrams, and Latin content
 * words. Over Unicode scalars (`Array.from`), so a supplementary-plane Han character is one
 * term and not two surrogates' worth.
 *
 * COUPLED: exported for `scripts/gate/checks/rederivation-generation.ts`, which may import
 * both packages and checks the Han half of this function against the real analyzer's. The
 * layering forbids importing `@zz/indexing` here, so without that check nothing would watch
 * the two copies. This name is on the package door for it and for no other caller.
 *
 * The Latin half is deliberately narrower and is not the same rule. `zz-lexical-v2` hands the
 * backend every word run unstemmed and unfiltered and lets the pinned `english` configuration
 * stop and stem them. This fixture has no backend, so it lowercases, drops the question-shaped
 * words in {@link CARRIES_NO_TOPIC}, and reads ASCII runs only. Those are fixture decisions
 * about a corpus, not claims about the analyzer.
 */
export function trialAnalyze(text: string): readonly string[] {
  const terms: string[] = [...latinWords(text)];
  for (const run of hanRuns(text)) {
    const scalars = Array.from(run);
    for (let i = 0; i < scalars.length; i += 1) {
      terms.push(scalars[i]);
      if (i + 1 < scalars.length) terms.push(scalars[i] + scalars[i + 1]);
    }
  }
  return terms;
}

/** An analyzer, so the probe can hand `searchCorpus` a broken one and watch the search go
 *  silent rather than being told that it would. */
export type TrialAnalyzer = (text: string) => readonly string[];

/**
 * Whether the query was framed so the index can match the material's language, which is
 * `RecallSearchReceipt.language_qualified`'s contract. Qualified iff every Han run of two
 * scalars or more produced at least one Han term shorter than the run — that is, iff the
 * analyzer segmented it. A tokenizer that splits on whitespace hands back the run itself and
 * nothing shorter, so it reports unqualified and the episode may not claim a clean empty.
 */
function languageQualified(query: string, analyzer: TrialAnalyzer): boolean {
  const terms = analyzer(query);
  return hanRuns(query).every((run) => {
    const length = Array.from(run).length;
    if (length < 2) return true;
    return terms.some((t) => isHanScalar(Array.from(t)[0] ?? "") && Array.from(t).length < length);
  });
}

/** Han bigrams only — contiguous two-scalar evidence, as opposed to a unigram two documents
 *  can share by accident. How many of these two texts share decides the lane below. */
function hanBigrams(terms: readonly string[]): ReadonlySet<string> {
  return new Set(terms.filter((t) => {
    const scalars = Array.from(t);
    return scalars.length === 2 && isHanScalar(scalars[0]) && isHanScalar(scalars[1]);
  }));
}

/** A crude stand-in for the `english` configuration's stemmer: two content words match when
 *  one is a prefix of the other and the shorter is at least five characters, so `decide`
 *  reaches `decided`. It is not snowball and does not claim to be. */
function latinMatches(queryWord: string, documentWord: string): boolean {
  if (queryWord === documentWord) return true;
  const [short, long] = queryWord.length <= documentWord.length
    ? [queryWord, documentWord] : [documentWord, queryWord];
  return short.length >= 5 && long.startsWith(short);
}

// The documents

/**
 * The Chinese text below is fixture data, in the same sense the frozen check's Chinese query
 * is: the old document has to be written in the language it was written in. Every comment,
 * identifier and diagnostic in this package is English.
 */
function documents(): TrialDocument[] {
  const doc = (
    d: Omit<TrialDocument, "head_text" | "head_language" | "translation_of" | "readable"
      | "read_failure" | "superseded_by"> & Partial<TrialDocument>,
  ): TrialDocument => ({
    head_text: null, head_language: "en", translation_of: null, readable: true,
    read_failure: null, superseded_by: null, ...d,
  });
  return [
    doc({
      id: "doc/mig-zh",
      title: "Migration freeze decision, as it was recorded",
      subject: "document", shelf: "team", claim_kind: "approved_decision",
      head_language: "zh",
      revisions: [{
        id: "r1", language: "zh", recorded_at: "2024-03-04",
        text: "这个迁移会破坏旧的模式，所以我们决定先冻结写入，再切换到新的模式。",
      }],
    }),
    doc({
      id: "doc/mig-en-rendering",
      title: "English rendering of the migration freeze decision",
      subject: "document", shelf: "team", claim_kind: "approved_decision",
      translation_of: "doc/mig-zh",
      revisions: [{
        id: "r1", language: "en", recorded_at: "2026-01-19",
        text: "This migration will break the old schema, so we decided to freeze writes first "
          + "and then cut over to the new schema.",
      }],
    }),
    doc({
      id: "doc/mig-en-control",
      title: "Index rebuild migration proposal",
      subject: "document", shelf: "team", claim_kind: "stated_intent",
      revisions: [{
        id: "r1", language: "en", recorded_at: "2025-11-02",
        text: "We propose that the index rebuild migration runs after the freeze; nothing is "
          + "decided yet.",
      }],
    }),
    doc({
      id: "doc/mig-zh-ops",
      title: "Migration cutover observation, body unretrievable",
      subject: "document", shelf: "team", claim_kind: "observed_result",
      head_language: "zh", readable: false,
      read_failure: "the stored body for doc/mig-zh-ops@r1 is not retrievable: the revision row "
        + "carries no text",
      revisions: [{
        id: "r1", language: "zh", recorded_at: "2024-05-20",
        text: "迁移上线后我们观察到旧的模式仍然在被写入。",
      }],
    }),
    doc({
      id: "doc/schema-note",
      title: "Schema naming convention",
      subject: "node", shelf: "team", claim_kind: "distilled_learning",
      head_language: "zh",
      revisions: [{
        id: "r1", language: "zh", recorded_at: "2025-06-11", text: "模式命名的约定写在这里。",
      }],
    }),
    doc({
      id: "doc/mig-legacy",
      title: "Legacy migration runbook, imported without revision history",
      subject: "document", shelf: "team", claim_kind: "reported_result",
      revisions: [],
      head_text: "The legacy migration runbook records that the freeze was applied by hand "
        + "before each cutover.",
    }),
  ];
}

/**
 * DELIBERATE: a fresh corpus per call. `trial(…, { thenSupersede: true })` appends a revision,
 * and a module-level corpus would carry that revision into every later trial in the same
 * process — the frozen check runs four trials in a row.
 */
export function trialCorpus(): TrialCorpus {
  const docs = documents();
  const pristine = new Map<string, ReadonlyMap<string, string>>();
  for (const d of docs) pristine.set(d.id, new Map(d.revisions.map((r) => [r.id, r.text])));
  return { documents: docs, pristine };
}

// Addressing, reading, superseding

export function documentOf(corpus: TrialCorpus, id: string): TrialDocument | null {
  return corpus.documents.find((d) => d.id === id) ?? null;
}

/** The revision a document currently ends at, or null for one imported with no history. */
export function headRevisionOf(doc: TrialDocument): TrialRevision | null {
  return doc.revisions.length > 0 ? doc.revisions[doc.revisions.length - 1] : null;
}

/** The revision a citation names, or null when it names only a current path. */
export function pinnedRevisionOf(ref: string): string | null {
  const at = ref.lastIndexOf("@");
  return at > 0 ? ref.slice(at + 1) : null;
}

export function documentIdOf(ref: string): string {
  const at = ref.lastIndexOf("@");
  return at > 0 ? ref.slice(0, at) : ref;
}

/**
 * The citation an episode forms for a document it has just read.
 *
 * A document with no revision history has only a current path, whatever the episode was
 * allowed to address. That is the structural half of the current-path rule; the other half is
 * an episode restricted to `current_path`.
 */
export function citationFor(doc: TrialDocument, assurance: TrialAssurance): string {
  const head = headRevisionOf(doc);
  if (assurance === "current_path" || head === null) return doc.id;
  return `${doc.id}@${head.id}`;
}

/**
 * The result of opening a citation. A discriminated union, which is the whole enforcement of
 * "no conclusion without the original text": `text` and `language` exist only on the `ok`
 * branch, so the single expression in `recall-trial.ts` that builds a quote can only build one
 * from a successful read.
 */
export type TrialRead =
  | { readonly ok: true; readonly text: string; readonly language: TrialLanguage;
      readonly revision: string | null }
  | { readonly ok: false; readonly failure: string };

/**
 * Open the original text behind a citation.
 *
 * A translation is refused by name rather than ranked lower. `doc/mig-en-rendering` is
 * readable, well formed and says exactly what the English asker wants to hear, and is not the
 * original text of anything — so the read of one fails and says why, and the failure travels
 * with the finding as an unresolved question.
 */
export function readOriginalText(corpus: TrialCorpus, ref: string): TrialRead {
  const doc = documentOf(corpus, documentIdOf(ref));
  if (doc === null) return { ok: false, failure: `${ref} names no document in the searched corpus` };
  if (doc.translation_of !== null) {
    return { ok: false, failure: `${doc.id} is registered as a translation of ${doc.translation_of}; `
      + "a translation is a search hypothesis and is not the original text of anything" };
  }
  if (!doc.readable) {
    return { ok: false, failure: doc.read_failure ?? `${doc.id} could not be opened` };
  }
  const pinned = pinnedRevisionOf(ref);
  if (pinned !== null) {
    const revision = doc.revisions.find((r) => r.id === pinned);
    if (revision === undefined) {
      return { ok: false, failure: `${ref} names a revision this document does not carry` };
    }
    return { ok: true, text: revision.text, language: revision.language, revision: revision.id };
  }
  const head = headRevisionOf(doc);
  if (head !== null) return { ok: true, text: head.text, language: head.language, revision: head.id };
  if (doc.head_text !== null) {
    return { ok: true, text: doc.head_text, language: doc.head_language, revision: null };
  }
  return { ok: false, failure: `${doc.id} has neither a revision nor a current body` };
}

/** Append a new head and record what supersedes what. Append: the revision the episode already
 *  cited is left exactly as it was, which is the state `citationFollowedHead` measures against. */
export function supersedeDocument(corpus: TrialCorpus, id: string, text: string): string | null {
  const doc = documentOf(corpus, id);
  if (doc === null) return null;
  const head = headRevisionOf(doc);
  if (head === null) return null;
  const next: TrialRevision = {
    id: `r${doc.revisions.length + 1}`, text, language: head.language,
    recorded_at: "2026-09-21",
  };
  doc.revisions.push(next);
  doc.superseded_by = `${doc.id}@${next.id}`;
  return doc.superseded_by;
}

/**
 * Whether anything has been written into a document's original text since the corpus was
 * built. Two faults, one answer: a revision that exists in the snapshot and reads differently
 * now has been rewritten, and a revision carrying the whole of a registered translation's text
 * has had a rendering spliced into it. A revision appended after the snapshot — what
 * supersession does — is not compared, because superseding a document is not editing it.
 */
export function translationWasInserted(corpus: TrialCorpus, id: string): boolean {
  const doc = documentOf(corpus, id);
  const snapshot = corpus.pristine.get(id);
  if (doc === null || snapshot === undefined) return false;
  const renderings = corpus.documents
    .filter((d) => d.translation_of === id)
    .flatMap((d) => d.revisions.map((r) => r.text));
  for (const revision of doc.revisions) {
    const original = snapshot.get(revision.id);
    if (original === undefined) continue;
    if (revision.text !== original) return true;
    if (renderings.some((t) => revision.text.includes(t))) return true;
  }
  return false;
}

// The search

/** One row as a search returns it: which document, which lanes reached it, and the excerpt the
 *  row carries. The excerpt is not the original text — it is what a row shows without anything
 *  being opened, and the probe uses it to build the quote the real trial refuses to build. */
interface TrialHit {
  readonly doc_id: string;
  readonly via: readonly string[];
  readonly excerpt: string;
}

interface TrialSearch {
  readonly hits: readonly TrialHit[];
  readonly language_qualified: boolean;
  readonly withheld: number;
}

/** Ranked candidates beyond this are withheld, and a receipt that withholds may not claim a
 *  clean empty. Six documents and a cap of six means zero today; it is computed all the same. */
const RETURNED_AT_MOST = 6;

function textOf(doc: TrialDocument): string {
  return [...doc.revisions.map((r) => r.text), doc.head_text ?? ""].join(" ");
}

function excerptOf(doc: TrialDocument): string {
  return Array.from(textOf(doc).trim()).slice(0, 16).join("");
}

/**
 * `via` in the live handler's own vocabulary — `lexical`, `lexical-broad`, `evidence` — so the
 * trial maps it with `recall.ts`'s `matchKindFromVia` instead of inventing a second set of lane
 * names beside it.
 *
 *   `lexical`        three or more shared Han bigrams, or every content word of the query
 *                    present. Contiguous evidence, not a coincidence of common characters.
 *   `lexical-broad`  some overlap and not that much: no document contained everything asked
 *                    for, which is what the broad lane means upstream, so these rows are leads.
 *   `evidence`       reached through a relation rather than through the query's vocabulary. A
 *                    translation and its original reach each other this way, in both
 *                    directions, and a row that shares no word with the question is a lead
 *                    until its original text is read.
 */
export function searchCorpus(
  corpus: TrialCorpus,
  query: string,
  analyzer: TrialAnalyzer = trialAnalyze,
): TrialSearch {
  const queryTerms = analyzer(query);
  const queryBigrams = hanBigrams(queryTerms);
  const queryLatin = latinWords(query);
  const direct: TrialHit[] = [];
  for (const doc of corpus.documents) {
    const docTerms = analyzer(textOf(doc));
    const docBigrams = hanBigrams(docTerms);
    const docLatin = new Set(docTerms.filter((t) => !isHanScalar(Array.from(t)[0] ?? "")));
    const sharedBigrams = [...queryBigrams].filter((b) => docBigrams.has(b)).length;
    const matchedWords = queryLatin.filter((w) => [...docLatin].some((d) => latinMatches(w, d)));
    const complete = queryLatin.length > 0 && matchedWords.length === queryLatin.length;
    if (sharedBigrams >= 3 || complete) {
      direct.push({ doc_id: doc.id, via: ["lexical"], excerpt: excerptOf(doc) });
    } else if (sharedBigrams >= 1 || matchedWords.length > 0) {
      direct.push({ doc_id: doc.id, via: ["lexical-broad"], excerpt: excerptOf(doc) });
    }
  }
  const reached = new Set(direct.map((h) => h.doc_id));
  const graph: TrialHit[] = [];
  for (const hit of direct) {
    const doc = documentOf(corpus, hit.doc_id);
    if (doc === null) continue;
    const related = corpus.documents.filter((d) =>
      (d.translation_of === doc.id || (doc.translation_of !== null && d.id === doc.translation_of))
      && !reached.has(d.id));
    for (const d of related) {
      reached.add(d.id);
      graph.push({ doc_id: d.id, via: ["evidence"], excerpt: excerptOf(d) });
    }
  }
  const all = [...direct, ...graph];
  return {
    hits: all.slice(0, RETURNED_AT_MOST),
    language_qualified: languageQualified(query, analyzer),
    withheld: Math.max(0, all.length - RETURNED_AT_MOST),
  };
}
