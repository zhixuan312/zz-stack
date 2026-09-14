/**
 * What every stage of every flow LEAVES BEHIND, against the documents that flow declares —
 * in both directions, for whatever is in the catalog rather than for a list written by hand.
 *
 * WHY IT IS BOTH DIRECTIONS AND NOT ONE. `documents[].stage` and `stages[].produces` are two
 * statements of one fact written in two places, and different readers take different ones:
 * the console's stepper derives what a stage writes from `documents[].stage`, `skill_view`
 * prints it from `stages[].produces`. A check that only resolved `produces` forward would pass
 * a manifest where a document points at a stage that points somewhere else — the two halves
 * agreeing that a document exists while disagreeing about who writes it — and the console and
 * the door would then describe different flows with no error anywhere.
 *
 * WHAT WAS ALREADY HERE, AND WHY THIS IS NOT A SECOND COPY OF IT. Two checks touch this ground
 * and both are pinned to a written-down list of packages:
 *   - `checks/sdlc-documents.ts` asserts all three properties — presence, forward resolution
 *     and reciprocity — for ONE manifest, `catalog/sdlc/sdlc-flow/flow.json`, named as a
 *     literal at the top of the file. Nothing it says reaches zz-plugin-eval.
 *   - `checks/manifests-conform.ts` asserts presence only, over a hardcoded array of four
 *     `[name, dir]` pairs. It says nothing about whether a produced document exists or about
 *     reciprocity in either direction.
 * Both happen to cover today's catalog because today's catalog is the list they were written
 * from. The fifth flow anybody adds is covered by neither, silently — which is the same
 * failure `checks/manifests-conform.ts`'s own hardcoded list already caused once, when it
 * read `<package>/skills` for the baseline, found no directory, and exempted a whole tree from
 * the rule it existed to enforce. This walks `flows`, so the subject is the catalog.
 *
 * ITS SUBJECT IS A FLOW, WHICH MEANS A PACKAGE THAT DECLARES DOCUMENTS. That is `isFlow()` in
 * @zz/catalog — `(manifest.documents?.length ?? 0) > 0` — and it is the classification the
 * platform itself branches on, not "has stages". `zz-core` and `zz-access` declare no
 * documents and no stages, and asking `produces` of a package with no stages at all would be
 * asking a question about a flow of something that is not one.
 *
 * "record" AND "nothing" ARE ANSWERS, NOT OMISSIONS, and that is the whole reason the field is
 * three-valued rather than optional. Three of zz-plugin-eval's five stages write scores and
 * profiles into the platform's own tables and produce no document; sdlc-execute's output is
 * the repository. A check that demanded a document name from every stage would force a fake
 * `build.md` into existence to satisfy it — the over-correction @zz/contracts names at the
 * field itself: an optional field answers "the author forgot" and "this stage genuinely
 * produces nothing" with the same absence, and those are different facts about a flow.
 *
 * THE SCHEMA CANNOT DO THIS. `FlowStage.produces` is
 * `z.union([z.string().min(1), z.literal("record"), z.literal("nothing")])`, so every
 * non-empty string validates and `"invented.md"` is as good as `"spec.md"` to zod. Presence is
 * the only half the contract can enforce; whether the claim is TRUE of the rest of the
 * manifest is this file's question.
 *
 * EVERY OFFENCE IN ONE RUN. A manifest is edited by hand and its errors arrive in bunches;
 * failing on the first would make fixing a manifest a sequence of gate runs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { flows } from "../facts.ts";
import { check, note } from "../run.ts";

/** The two values that are a stage saying what it leaves behind WITHOUT naming a document.
 *  Read from the contract's own literals, not invented here — the union in @zz/contracts is
 *  `z.string() | "record" | "nothing"`, and a third literal added there must arrive here or
 *  this check would report it as an undeclared document. */
const NOT_A_DOCUMENT = new Set(["record", "nothing"]);

check("every stage says what it leaves behind, and the document it names names it back", () => {
  const bad = [];
  // COUNTED, and reported when the check passes. A check whose subject is computed can reach
  // nothing at all and pass — the silent skip this gate has been caught by before, when a
  // pattern reached 22 of 60 blocks and the other 38 were nobody's business. The counts are
  // the evidence the walk arrived somewhere, and the zero case below is a failure rather than
  // a pass.
  let examined = 0, stages = 0, documents = 0;

  for (const f of flows) {
    const where = `${f.owner}/${f.flow}`;
    let m;
    try {
      m = JSON.parse(readFileSync(join(f.dir, "flow.json"), "utf8"));
    } catch (err) {
      // Another check owns "every flow.json parses"; this one says which question it could
      // not ask, rather than taking the whole gate down from inside a walk.
      bad.push(`${where}: flow.json does not parse, so nothing here could be read — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const docs = m.documents ?? [];
    // NOT "HAS STAGES". A package that declares no documents is not a flow, and the platform
    // classifies on exactly this field: @zz/catalog's isFlow().
    if (!docs.length) continue;
    examined++;
    const declared = new Map<string, { name: string; stage?: string }>(
      docs.map((d: { name: string; stage?: string }) => [d.name, d]));
    documents += docs.length;

    for (const s of m.stages ?? []) {
      stages++;
      if (!s.produces) {
        bad.push(`${where}: stage '${s.name}' declares no produces — name the document it ` +
                 `writes, or "record" if its result is stored by the platform, or "nothing"`);
        continue;
      }
      if (NOT_A_DOCUMENT.has(s.produces)) continue;
      const d = declared.get(s.produces);
      if (!d) {
        bad.push(`${where}: stage '${s.name}' produces '${s.produces}', which this flow ` +
                 `declares no document for — it declares ${[...declared.keys()].join(", ")}`);
        continue;
      }
      // THE SECOND DIRECTION, and the one a forward-only check cannot see. The document
      // exists and is produced; it just does not agree about who writes it.
      if (d.stage !== s.name) {
        bad.push(`${where}: stage '${s.name}' produces ${d.name}, and ${d.name} says ` +
                 `${d.stage ? `stage '${d.stage}'` : "no stage"} writes it — the two halves of ` +
                 "the manifest name different stages for one document");
      }
    }

    // AND THE DOCUMENTS NOTHING CLAIMS. This is not the mirror of the loop above: a document
    // with no `stage` field of its own is invisible to `catalog-stages.ts`'s "a document's
    // declared stage is a stage its flow has", which skips it, and invisible to the forward
    // resolution here, which only ever looks at documents some stage already named.
    const produced = new Set((m.stages ?? []).map((s: { produces?: string }) => s.produces).filter(Boolean));
    for (const d of docs) {
      if (!produced.has(d.name)) {
        bad.push(`${where}: document ${d.name} is produced by no stage — nothing in this ` +
                 "manifest says who writes it");
      }
    }
  }

  if (!examined) {
    return `no package in the catalog was classified as a flow, so this check read nothing — ` +
           `${flows.length} manifest(s) were walked and none declared documents`;
  }
  note(`      ${examined} flow(s), ${stages} stage(s), ${documents} document(s)`);
  return bad.length ? bad.join("; ") : null;
});
