import { readFileSync } from "node:fs";
import { join } from "node:path";

import { deriveOutcome, closeInitiative, handoverClaims } from "@zz/contracts";
import { root, withoutComments} from "../read.ts";
import { check } from "../run.ts";

check("a close says only what is known and a handover claims only what it verified", () => {
  if (deriveOutcome({ disposition: "finished", accepted_by: "A" }) !== "accepted") return "finished with an acceptor is not accepted";
  if (deriveOutcome({ disposition: "finished", no_signoff_reason: "r" }) !== "delivered") return "finished with no sign-off is not delivered";
  if (deriveOutcome({ disposition: "abandoned" }) !== "abandoned") return "abandoned is not abandoned";
  if (closeInitiative({ disposition: "finished" }).acceptedByHand) return "outcome was written by hand rather than derived";

  const ab = closeInitiative({ disposition: "abandoned", reachedStage: "spec" });
  if (ab.stages.some((s) => s.state === "established" && !s.evidence.length)) {
    return "an abandoned close recorded a prior stage as established with no evidence";
  }
  const second = closeInitiative({ disposition: "finished", already: true });
  if (second.ok) return "an initiative closed twice";
  const ungated = closeInitiative({ disposition: "finished", gatesRecorded: false });
  if (ungated.ok) return "an initiative closed with a declared gate left unrecorded";

  const h = handoverClaims({ proposed_team_nodes: "2", mintedTeamNodes: 0 });
  if (h.proposedIsEnforced) return "the handover count is represented as read-back enforcement; nothing reads it back";
  if (!h.selfReported) return "the handover count is not labelled self-reported";
  if (handoverClaims({ expectedImpact: "x" }).observedImpact) return "expected impact was recorded as observed impact";
});

check("the migration's stand-in documents cannot be read back as audit rounds that happened", () => {
  // THE MIGRATION WRITES DOCUMENTS INTO THE SLOT IT IS WAIVING, and that is the point: a
  // waived audit should be VISIBLE at `spec-audit.md` rather than inferred from an absence.
  // But the same migration derives evidence from the presence of that file — historically an
  // audit round wrote exactly `spec-audit.md` — so writing the stand-ins made the next run
  // count all 22 of them as rounds that happened: 181 evidence entries instead of 159, and
  // the 22 waivers gone. Nothing refused it, and the log would have said an audit existed
  // for every round nobody ran, which is what FR-28 and FR-29 forbid.
  //
  // It is invisible on the first run and wrong on every run after, so only re-running catches
  // it. This check is what makes re-running unnecessary to find out.
  //
  // THE MARKER MUST LIVE IN THE DOCUMENT, not in a side table: control tables are the thing a
  // migration rebuilds, and a stand-in recognisable only there comes back as evidence the
  // moment they are. So the assertion is that the same constant writes the stand-in's title
  // AND filters the aggregate every later branch reads.
  const src = withoutComments(readFileSync(join(root, "scripts/adopt-control-loop.ts"), "utf8"));
  const marker = /const NO_ROUND = "([^"]+)"/.exec(src)?.[1];
  if (!marker) return "adopt-control-loop.ts no longer declares NO_ROUND, the marker that tells a stand-in from a round";
  if (!new RegExp(`\\\`# \\$\\{step\\} \\$\\{NO_ROUND\\}`).test(src)) {
    return "the stand-in's title no longer carries NO_ROUND, so nothing on the document says it is a stand-in";
  }
  if (!/filter \(where title is null or position\(\$1 in title\) = 0\) as docs/.test(src)) {
    return "the derivation's docs aggregate no longer excludes stand-ins by title — a stand-in will be counted as an audit round that happened";
  }
  if (!/order by initiative`, \[NO_ROUND\]\)/.test(src)) {
    return "the exclusion's parameter is no longer NO_ROUND, so the title written and the title filtered can drift apart";
  }
  return null;
});
