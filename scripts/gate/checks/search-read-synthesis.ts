import { trial } from "@zz/contracts";
import { check } from "../run.ts";

check("search to pinned read to synthesis holds in both languages and cannot be redirected", () => {
  for (const [q, lang] of [["这个迁移会破坏旧的模式里的迁移是什么意思", "zh"], ["what did we decide about migration", "en"]] as const) {
    const t = trial(q);
    if (t.result === "no_relevant_match_in_searched_scope") return `the ${lang} trial found nothing in a corpus that contains the answer`;
    if (t.answer_language !== lang) return `the ${lang} trial answered in ${t.answer_language}`;
    const f = t.findings[0];
    if (!f) return `the ${lang} trial produced no finding`;
    if (!f.original_quote) return `the ${lang} finding carries no original-language quotation`;
    // "AN OBSERVED RESULT NEEDS A SUCCESSFUL READ" IS NOT ASKED HERE, AND THIS IS WHERE IT WENT.
    // A clause `f.claim_kind === "observed_result" && !f.readOriginal` stood on this line and
    // could never fire. Measured, by running both trials: the zh one returns approved_decision,
    // distilled_learning, author_inference, author_inference; the en one returns
    // approved_decision, reported_result, stated_intent, author_inference. No observed_result in
    // any position in either — so widening it past findings[0] would not have reached it either.
    //
    // The property is covered, and driven rather than hoped for. recall-trial-probe.ts's
    // observedResultsRequireASuccessfulRead() takes doc/mig-zh-ops — claim_kind
    // "observed_result", readable false — and runs both arms: a control asserting the episode
    // reports author_inference carrying the read failure, and a faulted arm that builds the
    // quotation out of the search row's excerpt and watches the same unopened document get
    // promoted to an observed result. That probe chooses its subject; this clause waited for a
    // query to rank one first, and no query does.
    if (f.translationInOriginal) return "a translation was written into the original document";
  }
  const pinned = trial("migration", { thenSupersede: true });
  if (pinned.citationFollowedHead) return "superseding the original silently redirected the old citation to the new head";
  if (!pinned.supersessionReported) return "supersession was not reported to the reader";
  const lead = trial("migration", { assurance: "current_path" });
  if (lead.authorizedPinnedEffect) return "a current-path legacy lead authorized a pinned effect";
});
