import { planSearch } from "@zz/indexing";
import { check } from "../run.ts";

// DELIBERATE: two cases, because only one of them reaches the stage loop. `planSearch`
// refuses an unmappable filter on its first line, so a case built on `initiative` or `flow`
// leaves the loop below iterating over four empty arrays. `tag` is the one scope filter with
// a native mapping, so it is the one that can prove the restriction reaches every stage.
check("an unmappable scope restriction is refused rather than silently dropped", () => {
  for (const filters of [{ initiative: "2026-09-20-x" }, { flow: "sdlc-flow" }]) {
    const p = planSearch({ query: "迁移", filters, broadened: true });
    if (p.status !== "unsupported_filter") {
      return `planSearch accepted ${Object.keys(filters)[0]}, which no native table carries — `
           + `a filter nothing can apply must be refused, never reported as applied`;
    }
    if (p.items?.length) return "an unsupported_filter refusal still returned items";
    if (!p.reason) return "the refusal names no reason, so a caller cannot tell what it may ask instead";
    for (const stages of [p.lanes, p.neighbours, p.rescues, p.counts]) {
      if (stages.length) return "a refused call still planned stages to run";
    }
  }
});

check("a tag restriction reaches every lane, rescue and page", () => {
  const p = planSearch({ query: "迁移", filters: { tag: "platform" }, broadened: true });
  if (p.status === "unsupported_filter") return `planSearch refused a tag filter: ${p.reason ?? "(no reason)"}`;
  const stages = [...p.lanes, ...p.neighbours, ...p.rescues, ...p.counts];
  if (!stages.length) return "a mappable filter planned no stages at all, so nothing carried the restriction";
  for (const stage of stages) {
    if (!stage.appliedFilters?.tag) return `stage ${stage.name} did not apply the tag restriction`;
    if (stage.filteredAfterCap) return `stage ${stage.name} filtered after its cap, which filters a truncated pool`;
  }
  if (p.effective_filters?.source !== "server") return "effective_filters was not reported from trusted server metadata";
  if (p.effective_filters?.tag !== "platform") return "effective_filters lost the tag the caller asked for";

  // A call that restricts nothing must not report a restriction it was never given.
  const open = planSearch({ query: "迁移", broadened: true });
  if (open.status === "unsupported_filter") return "planSearch refused a call with no filters at all";
  const claimed = [...open.lanes, ...open.neighbours, ...open.rescues, ...open.counts]
    .find((stage) => stage.appliedFilters?.tag);
  if (claimed) return `stage ${claimed.name} claimed a tag restriction the caller never asked for`;
});
