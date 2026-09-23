import { readFileSync } from "node:fs";
import { join } from "node:path";
import { trialAnalyze } from "@zz/contracts";
import { analyze } from "@zz/indexing";
import { root, withoutComments} from "../read.ts";
import { check } from "../run.ts";

check("the recall trial's analyzer finds the same Han terms as zz-lexical-v2", () => {
  // TWO IMPLEMENTATIONS OF ONE SEGMENTATION, AND THIS IS WHAT WATCHES THEM.
  //
  // `packages/contracts/src/recall-trial-corpus.ts` declares its own `trialAnalyze`, and its
  // header says so: it emits "unigrams and adjacent Han bigrams the way `zz-lexical-v2` does".
  // It has to. `@zz/contracts` sits BELOW `@zz/indexing` and cannot import the real analyzer
  // from `packages/indexing/src/tenant-analysis.ts`, so the layering forces the copy and that
  // part is legitimate. What was missing is anything holding the copy to the original —
  // exactly the gap `rederivation-generation.ts` was written for one directory over, where
  // two implementations of one weighting "is how the write path and the backfill drifted
  // apart in the first place". A gate check may import from both packages; only
  // `@zz/contracts` is layer-restricted.
  //
  // CHECKED TWO WAYS, because neither alone is enough — the same pairing the precedent uses.
  // The fixture must actually REACH this function, or the agreement below would be measured
  // on a copy nothing calls; and the two must agree on real text, or the import would be
  // ceremony. The first half is a source read because the coupling is a default parameter,
  // which no value passed in can observe.
  const corpus = withoutComments(readFileSync(join(root, "packages/contracts/src/recall-trial-corpus.ts"), "utf8"));
  if (!/analyzer:\s*TrialAnalyzer\s*=\s*trialAnalyze\b/.test(corpus)) {
    return "searchCorpus no longer defaults to trialAnalyze — the trial is searching with some "
         + "other analysis, and the agreement checked below is with a function nothing calls";
  }

  // WHAT "THE SAME TERMS" MEANS HERE, AND WHY IT IS NOT STRICT EQUALITY.
  //
  // The Han half is one rule and must agree in BOTH directions: neither analyzer may find a
  // Han unigram or an adjacent-pair bigram the other cannot. That is the claim the fixture's
  // header makes, and it is the claim that decides whether an unspaced Chinese question can be
  // matched at all.
  //
  // The Latin half is deliberately two different rules and equality there would be a lie that
  // gets relaxed the first time it fires. `zz-lexical-v2` hands the backend every word run,
  // unstemmed and unstopped, because the pinned `english` configuration does the stopping and
  // the stemming; the fixture has no backend, so it lowercases, drops its own question-shaped
  // words and reads ASCII runs only. So the direction that matters is containment: the trial
  // must not be able to find a Latin term the real analyzer cannot. The reverse is the
  // fixture's own narrowing and is not a defect.
  const scalarsOf = (s: string): readonly string[] => Array.from(s);
  const isHan = (s: string): boolean => /\p{Script=Han}/u.test(s);

  // `zz<six hex><six hex>` back to the two scalars it encodes, so the two analyzers' bigrams
  // are compared as text rather than one being trusted to have encoded what it meant.
  const decodeBigram = (encoded: string): string | null => {
    const m = /^zh([0-9a-f]{6})([0-9a-f]{6})$/.exec(encoded);
    if (!m) return null;
    return String.fromCodePoint(parseInt(m[1], 16)) + String.fromCodePoint(parseInt(m[2], 16));
  };

  const missing = (want: ReadonlySet<string>, have: ReadonlySet<string>): readonly string[] =>
    [...want].filter((t) => !have.has(t));

  const inputs: readonly [string, string][] = [
    ["这个迁移会破坏旧的模式", "an unspaced Han run — the case a prose tokenizer cannot segment"],
    ["迁移", "a Han run of exactly two scalars: two unigrams and one bigram"],
    ["我", "a Han run of exactly one scalar: a unigram and NO bigram"],
    ["前migration后", "two one-scalar Han runs either side of a Latin word — a bigram must not cross it"],
    ["这个 迁移", "two Han runs separated by a space — a bigram must not cross that either"],
    ["迁移说明 schema v2", "mixed Han and Latin in one string"],
    ["Schema MIGRATION", "Latin the real analyzer keeps in its original case, the fixture lowercases"],
    ["what did we decide about the migration", "Latin only"],
    ["", "empty"],
    ["\u{20000}\u{20001}", "an adjacent supplementary-plane Han pair — scalars, not UTF-16 units"],
  ];

  for (const [text, why] of inputs) {
    const trial = trialAnalyze(text);
    const real = analyze(text);
    const label = `${JSON.stringify(text)} (${why})`;

    const trialUnigrams = new Set(trial.filter((t) => scalarsOf(t).length === 1 && isHan(t)));
    const realUnigrams = new Set(real.base.filter((t) => t.field === "han").map((t) => t.term));
    const lost = missing(realUnigrams, trialUnigrams);
    const invented = missing(trialUnigrams, realUnigrams);
    if (lost.length > 0) {
      return `on ${label} zz-lexical-v2 finds the Han unigram(s) ${lost.join(", ")} and the recall `
           + "trial's analyzer does not — the trial cannot reach material the live index can";
    }
    if (invented.length > 0) {
      return `on ${label} the recall trial's analyzer finds the Han unigram(s) ${invented.join(", ")} `
           + "and zz-lexical-v2 does not — the trial is demonstrating a retrieval the live index "
           + "cannot perform";
    }

    const trialBigrams = new Set(trial.filter((t) => {
      const s = scalarsOf(t);
      return s.length === 2 && isHan(s[0]) && isHan(s[1]);
    }));
    const realBigrams = new Set<string>();
    for (const encoded of real.ranking) {
      const decoded = decodeBigram(encoded);
      if (decoded === null) {
        return `zz-lexical-v2 produced the ranking term ${JSON.stringify(encoded)} on ${label}, which `
             + "is not a zh<six hex><six hex> Han bigram — this check can no longer read what it compares";
      }
      realBigrams.add(decoded);
    }
    const lostPairs = missing(realBigrams, trialBigrams);
    const inventedPairs = missing(trialBigrams, realBigrams);
    if (lostPairs.length > 0) {
      return `on ${label} zz-lexical-v2 ranks the adjacent Han bigram(s) ${lostPairs.join(", ")} and the `
           + "recall trial's analyzer does not produce them — the two disagree on what is adjacent";
    }
    if (inventedPairs.length > 0) {
      return `on ${label} the recall trial's analyzer produces the Han bigram(s) ${inventedPairs.join(", ")} `
           + "and zz-lexical-v2 ranks no such pair — the trial is pairing scalars the real analyzer "
           + "keeps apart";
    }

    // ASCII-SCOPED, AND SAID SO RATHER THAN LEFT TO BE DISCOVERED. The fixture's Latin run is
    // `[a-z0-9_]+` over lowercased text; `zz-lexical-v2`'s is `[\p{L}\p{N}_]`. On a non-ASCII
    // Latin word the fixture truncates (`café` analyses to `caf`) and containment would fail.
    // Every input above is ASCII on its Latin side, which is what this fixture's corpus is.
    const realLatin = new Set(real.base.filter((t) => t.field === "latin").map((t) => t.term.toLowerCase()));
    const trialLatin = trial.filter((t) => scalarsOf(t).length > 0 && !isHan(scalarsOf(t)[0]));
    const unreachable = trialLatin.filter((w) => !realLatin.has(w));
    if (unreachable.length > 0) {
      return `on ${label} the recall trial's analyzer finds the Latin term(s) ${unreachable.join(", ")} `
           + "and zz-lexical-v2 produces no word they could match — the trial can find text the live "
           + "index cannot";
    }
  }
});
