/**
 * The doors, the skills and the documents a tenant actually meets.

 * Which tools each door serves and under which nouns, which plugin owns which skill, what a
 * document must carry before it may be gated, and what the written record says about all of
 * it. The two bash suites are here too: they are about the deck skill's own shipped assets.
 */
import { check } from "../run.ts";
import { runsCheck, runsShell } from "../suite-runner.ts";

check("the manifest can express what the standard requires, and not what it replaced",
      runsCheck("contract-fields.ts"));

check("a command is what a manifest declares, not what a function derives from a skill name",
      runsCheck("commands-declared.ts"));

check("a flow is a plugin that declares documents, and zz-access is not one",
      runsCheck("flow-classification.ts"));

check("every plugin declares what it is, what it ships, and what each stage leaves behind",
      runsCheck("manifests-conform.ts"));

check("the core door speaks noun-first, and no caller still says the old name",
      runsCheck("core-names.ts"));

check("a revision names its cause — one route or the other, never neither and never both",
      runsCheck("revise-cause.ts"));

check("a document read takes a list and a version, and history never vouches for the present",
      runsCheck("document-reads.ts"));

check("the core door serves exactly its tools, and a removed tool is gone from every caller",
      runsCheck("core-surface.ts"));

check("the core door introduces itself to a client that reads nothing else, and the pointer survives",
      runsCheck("orientation.ts"));

check("opening is explicit and dated by the platform, and freeform gets no next move",
      runsCheck("initiative-open.ts"));

check("audit rounds follow evidence, a spent budget or a reopened agreement waits on the stakeholder",
      runsCheck("audit-rounds.ts"));

check("the /manage door is cut by role, the duplicates are gone, and the exception is kept",
      runsCheck("manage-surface.ts"));

check("the evaluation door serves its own tools, and the gateway reaches that door and not the other",
      runsCheck("eval-door.ts"));

check("sdlc closes on its review, gates it, and leaves its audits ungated",
      runsCheck("sdlc-documents.ts"));

check("the evaluation modules are on the evaluation side, and attest stays on the core one",
      runsCheck("eval-tools-moved.ts"));

check("the three verification stages leave a document, and keep their independence",
      runsCheck("verification-stages-write.ts"));

check("the evaluation door speaks four nouns, three names are deliberately untouched, and the graders and the chain check follow",
      runsCheck("eval-names.ts"));

check("every skill ships from the plugin that owns it, and its commands follow with it",
      runsCheck("skill-homes.ts"));

check("the two misnamed core skills are renamed, every caller moved, and an old step still resolves",
      runsCheck("skill-renames.ts"));

check("no shipped file states a count of this platform's own surface",
      runsCheck("derived-counts.ts"));

check("the written record matches the delivered surface, and no document outgrew the ceiling",
      runsCheck("docs-current.ts"));

check("a renamed plugin still resolves, and the updater's copy of the map is the contract's",
      runsCheck("plugin-alias.ts"));

check("the deck skill names one destination, and never the platform's document-write tool",
      runsShell("deck-destination.sh"));

check("the deck chassis carries no slides and the guidebook carries all of them",
      runsShell("deck-chassis-sections.sh"));

check("shipped zz-plugin-eval text describes trace evidence only, not the removed ablation block",
      runsCheck("eval-drift-free.ts"));

check("an evaluation protocol accepts every FR-6 field and refuses unbalanced weights, an unknown enum and an unexplained non-applicable dimension",
      runsCheck("eval-protocol-schema.ts"));

check("a request's digest ignores key order and the idempotency key, and a stored ledger row decides proceed, replay or conflict",
      runsCheck("eval-idempotency.ts"));
