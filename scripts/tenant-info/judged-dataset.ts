/**
 * judged-dataset.ts — what the judged dataset IS: its vocabulary (the declared counts, the
 * valid enums, the row shapes) and the deterministic generator that produces the exact bytes
 * committed at `testing/tenant-info/queries.jsonl` and `testing/tenant-info/qrels.jsonl`.
 *
 * SPLIT OUT OF benchmark.ts DURING I-23, AND THE FROZEN CHECKS CHOSE WHICH HALF MOVED. That
 * file was 463 lines of an unexemptable 700-line ceiling with this task's evaluator, report
 * validator and real command still owed to it. Two frozen plan-authored checks import
 * `validateJudgments` and `evaluateTargets` from `benchmark.ts` BY PATH, and a frozen check is
 * not editable — so the symbols they pin stayed and the generator, which no frozen check
 * imports, is what left. `inventory.ts` records the identical decision from I-3, having
 * learned it the same way: splitting toward what reads tidiest broke a check on the first run.
 *
 * H1 SIGNS THE TWO FILES BY HASH, so this generator is not a throwaway script. A signature
 * over bytes nobody can reproduce is a rubber stamp; the gate check "the committed judged
 * dataset is exactly what its generator produces, byte for byte" is what turns it into a
 * review, and it can only exist because the producer is tracked beside the vocabulary that
 * describes it.
 */

/** The nine declared query categories and each one's exact case count — `testing/tenant-info/
 *  queries.jsonl` must hold precisely these, no more, no fewer. */
export const CATEGORY_COUNTS: Readonly<Record<string, number>> = {
  "exact-reference": 70, "identifier-part": 70, "natural-language": 90, typo: 70,
  provenance: 70, lifecycle: 60, "scope-filter": 60, "no-answer": 70, isolation: 40,
};

/** Categories whose queries test cross-tenant isolation are exempt from the "answerable
 *  queries need a relevant judgment" rule: the correct outcome for one of these is a refusal,
 *  not a retrieved fixture, so a grade-0-only judgment is not a missing one. */
export const ISOLATION_CATEGORY = "isolation";

export const LANGUAGE_COUNTS: Readonly<Record<string, number>> = { en: 360, zh: 120, mixed: 120 };
export const TOTAL_QUERIES = 600;
export const DEV_COUNT = 480;
export const HELD_OUT_COUNT = 120;
export const VALID_SPLITS = new Set(["dev", "held-out"]);
export const VALID_LANGUAGES = new Set(["en", "zh", "mixed"]);
export const VALID_GRADES = new Set([0, 1, 2]);

/** Every field I-4's Contract requires on a query row, minus the ones checked more
 *  specifically elsewhere (`category`, `language`, `split`, `family`, `id`). */
export const REQUIRED_QUERY_FIELDS = [
  "query", "query_mode", "scopes", "filters", "caller_fixture", "answerable",
] as const;

export interface JudgedQuery {
  readonly id: string;
  readonly category: string;
  readonly language: string;
  readonly family: string;
  readonly query: string;
  readonly query_mode: string;
  readonly scopes: unknown;
  readonly filters: unknown;
  readonly caller_fixture: string;
  readonly split: string;
  readonly answerable: boolean;
}

export interface Qrel {
  readonly query_id: string;
  readonly ref: string;
  readonly grade: number;
  readonly evidence: string;
  readonly rationale: string;
  readonly reviewer: string;
}

// ─────────────────── the generator: where the signed hashes can be re-derived ───────────────────

/**
 * Rebuilds `testing/tenant-info/queries.jsonl` and `testing/tenant-info/qrels.jsonl` from
 * nothing but this function — no randomness, no clock, no filesystem read. H1 signs the two
 * files' hashes; a signature over bytes nobody can reproduce is a rubber stamp, not a review,
 * so the generator that PRODUCES those bytes is tracked here rather than left in a throwaway
 * script that leaves with whoever wrote it.
 *
 * Each category's per-language dev/held-out counts are pre-computed, not derived at 80/20
 * here, because a naive `round(0.8 * n)` on ("natural-language", "en": 54) gives 43/11 —
 * matching that language's own count — while the CATEGORY total needs 72/18 once "zh" and
 * "mixed" are added back in; the three language subtotals have to be chosen together so they
 * both hit 60/20/20 of the category AND sum to that category's 80/20. Same story for
 * "lifecycle"/"scope-filter" (36/12/12 → 28/8, 10/2, 10/2) and "isolation" (24/8/8 →
 * 20/4, 6/2, 6/2): the even 80/20 split of the WHOLE category doesn't fall out of splitting
 * each language slice independently, so it is recorded per language rather than computed.
 */
export function generateJudgedDataset(): { readonly queries: readonly JudgedQuery[]; readonly qrels: readonly Qrel[] } {
  interface LangSplit { readonly lang: "en" | "zh" | "mixed"; readonly dev: number; readonly held: number }
  interface CategoryPlan {
    readonly name: string; readonly answerable: boolean; readonly langs: readonly LangSplit[];
  }
  const PLAN: readonly CategoryPlan[] = [
    { name: "exact-reference", answerable: true, langs: [
      { lang: "en", dev: 34, held: 8 }, { lang: "zh", dev: 11, held: 3 }, { lang: "mixed", dev: 11, held: 3 },
    ] },
    { name: "identifier-part", answerable: true, langs: [
      { lang: "en", dev: 34, held: 8 }, { lang: "zh", dev: 11, held: 3 }, { lang: "mixed", dev: 11, held: 3 },
    ] },
    { name: "natural-language", answerable: true, langs: [
      { lang: "en", dev: 44, held: 10 }, { lang: "zh", dev: 14, held: 4 }, { lang: "mixed", dev: 14, held: 4 },
    ] },
    { name: "typo", answerable: true, langs: [
      { lang: "en", dev: 34, held: 8 }, { lang: "zh", dev: 11, held: 3 }, { lang: "mixed", dev: 11, held: 3 },
    ] },
    { name: "provenance", answerable: true, langs: [
      { lang: "en", dev: 34, held: 8 }, { lang: "zh", dev: 11, held: 3 }, { lang: "mixed", dev: 11, held: 3 },
    ] },
    { name: "lifecycle", answerable: true, langs: [
      { lang: "en", dev: 28, held: 8 }, { lang: "zh", dev: 10, held: 2 }, { lang: "mixed", dev: 10, held: 2 },
    ] },
    { name: "scope-filter", answerable: true, langs: [
      { lang: "en", dev: 28, held: 8 }, { lang: "zh", dev: 10, held: 2 }, { lang: "mixed", dev: 10, held: 2 },
    ] },
    { name: "no-answer", answerable: false, langs: [
      { lang: "en", dev: 34, held: 8 }, { lang: "zh", dev: 11, held: 3 }, { lang: "mixed", dev: 11, held: 3 },
    ] },
    { name: "isolation", answerable: false, langs: [
      { lang: "en", dev: 20, held: 4 }, { lang: "zh", dev: 6, held: 2 }, { lang: "mixed", dev: 6, held: 2 },
    ] },
  ];

  // The seven declared corpora (`inventory.ts`'s BASE_CORPORA) are not seven tenants:
  // primary_{current,evidence,history} is ONE tenant's three corpora, other_team_a and
  // other_team_b are one tenant each, and shared_* belongs to no tenant — it is the
  // cross-tenant pool `scopes: ["own_team", "shared"]` already grants. Only a tenant corpus
  // can plausibly be a caller's own context; only a corpus from a DIFFERENT tenant is a
  // genuine isolation violation.
  const TENANT_OF: Readonly<Record<string, string>> = {
    primary_current: "primary", primary_evidence: "primary", primary_history: "primary",
    other_team_a: "team_a", other_team_b: "team_b",
  };
  const TENANT_CORPORA = Object.keys(TENANT_OF);
  // The smallest per-corpus record count `planCorpora` will accept for any tenant corpus
  // (scale 0.1 — see `checks/tenant-info-corpus-shape.ts`, which exercises exactly that
  // floor). Every ref ordinal stays under this, not under the full-scale 150,000, so a qrel
  // resolves against whatever scale the fixture store actually gets generated at.
  const SMALLEST_TENANT_CORPUS_SIZE = 15000;

  const QUERY_MODE_BY_CATEGORY: Readonly<Record<string, string>> = {
    "exact-reference": "exact", "identifier-part": "exact", typo: "exact", isolation: "exact",
    "natural-language": "semantic", "no-answer": "semantic",
    provenance: "hybrid", lifecycle: "hybrid", "scope-filter": "hybrid",
  };

  const pad6 = (n: number): string => String(n).padStart(6, "0");

  // mulberry32 + FNV-1a seeding + a CJK-block codepoint draw, matching inventory.ts's
  // textFixture exactly: a "zh"/"mixed" query is made of the same kind of seed-derived CJK
  // characters as a "zh"/"mixed" fixture, not an English sentence wearing a language label.
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seedFrom(key: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  const zhChar = (rand: () => number): string => String.fromCodePoint(0x4e00 + Math.floor(rand() * 0x5200));

  // "exact-reference" and "identifier-part" are handed the real ref (in full, or the last 3
  // digits of its ordinal) because naming the target identifier IS those two categories'
  // premise. Every other category gets the query's own CASE NUMBER instead, never the ref —
  // a retrieval run must not be able to read the correct answer off the query text.
  const enTemplate = (category: string, corpus: string, caseNumber: number, ref: string, ordinal: number): string => {
    switch (category) {
      case "exact-reference": return `Show me the fixture record ${ref.replace(/\.txt$/, "")} exactly as filed.`;
      case "identifier-part": return `Which record in ${corpus} has an identifier ending "${pad6(ordinal).slice(-3)}"?`;
      case "natural-language": return `What does the document about case ${caseNumber} in ${corpus} actually say?`;
      case "typo": return `Wat does the docmuent about caes ${caseNumber} in ${corpus} actualy say?`;
      case "provenance": return `Who produced the record filed under ${corpus} case ${caseNumber}, and when?`;
      case "lifecycle": return `Has the record for case ${caseNumber} in ${corpus} been superseded or withdrawn?`;
      case "scope-filter": return `Within ${corpus}, filtered to case ${caseNumber}, what is currently in scope?`;
      case "no-answer": return `What is the launch date nobody in ${corpus} ever recorded for case ${caseNumber}?`;
      default: return `Show me case ${caseNumber} the way ${corpus} sees it.`; // isolation
    }
  };
  const localizedQuery = (rand: () => number, tag: string, mixed: boolean): string => {
    const len = 6 + Math.floor(rand() * 6);
    const words = ["tenant", "document", "record", "revision", "case", "query"];
    let out = "";
    for (let i = 0; i < len; i++) {
      out += mixed && rand() < 0.35
        ? (out ? " " : "") + words[Math.floor(rand() * words.length)]
        : zhChar(rand);
    }
    return `${out}（${tag}）`;
  };
  const queryText = (
    category: string, lang: "en" | "zh" | "mixed", corpus: string, caseNumber: number,
    ref: string, ordinal: number, globalIndex: number,
  ): string => {
    if (lang === "en") return enTemplate(category, corpus, caseNumber, ref, ordinal);
    const rand = mulberry32(seedFrom(`${globalIndex}:${category}:${lang}`));
    const tag = category === "exact-reference" ? ref.replace(/\.txt$/, "")
      : category === "identifier-part" ? `${corpus} …${pad6(ordinal).slice(-3)}`
      : `${corpus} #${caseNumber}`;
    return localizedQuery(rand, tag, lang === "mixed");
  };

  const queries: JudgedQuery[] = [];
  const qrels: Qrel[] = [];
  let globalIndex = 0;

  for (const category of PLAN) {
    for (const langSplit of category.langs) {
      const segments: readonly { readonly split: "dev" | "held-out"; readonly count: number }[] = [
        { split: "dev", count: langSplit.dev },
        { split: "held-out", count: langSplit.held },
      ];
      for (const segment of segments) {
        for (let local = 0; local < segment.count; local++) {
          globalIndex += 1;
          const id = `Q${String(globalIndex).padStart(4, "0")}`;
          const bucket = Math.floor(local / 5);
          const family = `${category.name}:${langSplit.lang}:${segment.split}:${bucket}`;
          const callerCorpus = TENANT_CORPORA[globalIndex % TENANT_CORPORA.length];

          let refCorpus: string;
          let grade: number;
          let rationale: string;
          if (category.name === ISOLATION_CATEGORY) {
            const callerIdx = TENANT_CORPORA.indexOf(callerCorpus);
            let otherIdx = (callerIdx + 1) % TENANT_CORPORA.length;
            while (TENANT_OF[TENANT_CORPORA[otherIdx]] === TENANT_OF[callerCorpus]) {
              otherIdx = (otherIdx + 1) % TENANT_CORPORA.length;
            }
            refCorpus = TENANT_CORPORA[otherIdx];
            grade = 0;
            rationale = `Fixture belongs to a different tenant ("${TENANT_OF[refCorpus]}", corpus "${refCorpus}") ` +
              `than the caller ("${TENANT_OF[callerCorpus]}", corpus "${callerCorpus}"); must not be surfaced ` +
              "across the isolation boundary.";
          } else if (category.name === "no-answer") {
            refCorpus = callerCorpus;
            grade = 0;
            rationale = "No fixture in the caller's accessible corpora answers this query; correctly withheld.";
          } else {
            refCorpus = callerCorpus;
            grade = 2;
            rationale = `Exact match fixture for this ${category.name} query within the caller's own corpus.`;
          }
          const ordinal = (globalIndex * 37) % SMALLEST_TENANT_CORPUS_SIZE;
          const ref = `${refCorpus}-${pad6(ordinal)}.txt`;
          const query = queryText(category.name, langSplit.lang, callerCorpus, globalIndex, ref, ordinal, globalIndex);

          queries.push({
            id, category: category.name, language: langSplit.lang, family,
            query, query_mode: QUERY_MODE_BY_CATEGORY[category.name],
            scopes: category.name === ISOLATION_CATEGORY ? ["own_team"] : ["own_team", "shared"],
            filters: {}, caller_fixture: callerCorpus, split: segment.split, answerable: category.answerable,
          });
          qrels.push({
            query_id: id, ref, grade, evidence: `${ref}:L1`, rationale, reviewer: "generator:tenant-info-i4",
          });
        }
      }
    }
  }

  return { queries, qrels };
}

/** JSON Lines, one compact object per line, trailing newline — the exact shape
 *  `readFileSync(...).trim().split("\n").map(JSON.parse)` in the frozen check expects, and
 *  the shape `testing/tenant-info/queries.jsonl`/`qrels.jsonl` are committed in. Exported
 *  alongside `generateJudgedDataset` so a caller re-deriving H1's signed bytes — or a gate
 *  check confirming the committed files still match — never has to reinvent this line. */
export const judgedDatasetToJsonl = (rows: readonly unknown[]): string =>
  `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
