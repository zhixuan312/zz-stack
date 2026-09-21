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
    if (f.claim_kind === "observed_result" && !f.readOriginal) return `the ${lang} finding claims an observed result without reading the original`;
    if (f.translationInOriginal) return "a translation was written into the original document";
  }
  const pinned = trial("migration", { thenSupersede: true });
  if (pinned.citationFollowedHead) return "superseding the original silently redirected the old citation to the new head";
  if (!pinned.supersessionReported) return "supersession was not reported to the reader";
  const lead = trial("migration", { assurance: "current_path" });
  if (lead.authorizedPinnedEffect) return "a current-path legacy lead authorized a pinned effect";
});
