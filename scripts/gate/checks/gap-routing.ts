import { routeGap, ACTION_KINDS, bootstrap, correctiveReturn, reviewClose } from "@zz/contracts";
import { check } from "../run.ts";

check("every gap kind reaches its resolver and no stage deadlocks", () => {
  if (ACTION_KINDS.length !== 9) return `${ACTION_KINDS.length} action kinds are defined, not 9`;
  const want: Record<string, string[]> = {
    fact: ["gather-evidence", "revise-targeted"], verification: ["run-experiment"],
    analysis: ["deepen-analysis"], preference: ["ask-person"], authority: ["ask-person"],
  };
  for (const [kind, allowed] of Object.entries(want)) {
    const a = routeGap({ kinds: [kind] });
    if (!allowed.includes(a.kind)) return `a ${kind} gap routed to ${a.kind}`;
    if (kind === "preference" || kind === "authority") {
      if (!a.blockedDecision) return `an ${kind} gap reached a person without naming the blocked decision`;
    }
  }
  const both = routeGap({ kinds: ["fact", "authority"] });
  if (both.collapsedToOne) return "coexisting gap kinds were collapsed into one";
  const none = routeGap({ kinds: [], noPermittedAction: true });
  if (none.kind !== "pause") return `a gap with no permitted action resolved to ${none.kind}, not pause`;
  if (!none.resumptionCondition) return "a pause carried no concrete resumption condition";

  if (bootstrap().inventedPriorOutcome) return "bootstrap invented a previous stage outcome";
  if (!correctiveReturn().invalidatesDependentReadiness) return "a corrective return left dependent readiness standing";
  if (correctiveReturn().requiresForwardProgressFirst) return "correction requires forward progress first, which is a deadlock";
  if (reviewClose().kind === "advance") return "review advanced to a stage that does not exist instead of granting close eligibility";
});
