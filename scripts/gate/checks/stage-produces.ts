/**
 * What every stage of every flow leaves behind, against the documents that flow declares — in both
 * directions, over whatever is in the catalog rather than a list written by hand.
 *
 * Both directions, because `documents[].stage` and `stages[].produces` are two statements of one
 * fact and different readers take different ones: the console's stepper derives what a stage writes
 * from `documents[].stage`, `skill_list` reads it from `stages[].produces`. Resolving `produces`
 * forward alone passes a manifest where a document points at a stage that points somewhere else,
 * and the console and the door then describe different flows with no error anywhere.
 *
 * COUPLED: `checks/sdlc-documents.ts` asserts all three properties for one named manifest, and
 * `checks/manifests-conform.ts` asserts presence only over a hardcoded array of packages. This one
 * walks `flows`, so its subject is the catalog and the next flow anybody adds is covered.
 *
 * Its subject is a flow, which means a package that declares documents — `isFlow()` in @zz/catalog,
 * `(manifest.documents?.length ?? 0) > 0`, the classification the platform itself branches on, not
 * "has stages". `zz-core` and `zz-access` declare neither documents nor stages.
 *
 * `record` and `nothing` are answers, not omissions, which is why the field is three-valued rather
 * than optional: three of zz-plugin-eval's five stages write into the platform's own tables and
 * produce no document, and sdlc-execute's output is the repository. An optional field answers "the
 * author forgot" and "this stage genuinely produces nothing" with the same absence.
 *
 * The schema cannot do this. `FlowStage.produces` is
 * `z.union([z.string().min(1), z.literal("record"), z.literal("nothing")])`, so every non-empty
 * string validates and `"invented.md"` is as good as `"spec.md"` to zod. Presence is the only half
 * the contract can enforce.
 *
 * Every offence in one run: a manifest is edited by hand and its errors arrive in bunches.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { flows } from "../facts.ts";
import { check, note } from "../run.ts";

/** The two values that are a stage saying what it leaves behind without naming a document. COUPLED:
 *  the union in @zz/contracts is `z.string() | "record" | "nothing"`, and a third literal added
 *  there must arrive here or this check reports it as an undeclared document. */
const NOT_A_DOCUMENT = new Set(["source", "record", "nothing"]);

check("every stage says what it leaves behind, and the document it names names it back", () => {
  const bad = [];
  // Counted, and reported when the check passes. A check whose subject is computed can reach nothing
  // at all and pass, so the counts are the evidence the walk arrived somewhere and the zero case
  // below is a failure rather than a pass.
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
    // Not "has stages". A package that declares no documents is not a flow, and the platform
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
                 `writes, or "source" for evidence another document changes because of, or ` +
                 `"record" if its result is stored by the platform, or "nothing"`);
        continue;
      }
      // A source stage names what its evidence is about, and only a source stage may.
      // `produces: "source"` says the stage leaves supporting material rather than a deliverable,
      // and `supports` says which document that material bears on. The contract requires the pair;
      // this is the half it cannot see, that the name resolves to a document this flow declares.
      if (s.produces === "source") {
        if (!s.supports) {
          bad.push(`${where}: stage '${s.name}' produces a source and names no document in ` +
                   "`supports` — evidence is always evidence FOR something");
        } else if (!declared.has(s.supports)) {
          bad.push(`${where}: stage '${s.name}' supports '${s.supports}', which this flow ` +
                   `declares no document for — it declares ${[...declared.keys()].join(", ")}`);
        }
        continue;
      }
      if (s.supports) {
        bad.push(`${where}: stage '${s.name}' produces '${s.produces}' and also names ` +
                 `supports: '${s.supports}' — only a stage producing a source supports one`);
        continue;
      }
      if (NOT_A_DOCUMENT.has(s.produces)) continue;
      const d = declared.get(s.produces);
      if (!d) {
        bad.push(`${where}: stage '${s.name}' produces '${s.produces}', which this flow ` +
                 `declares no document for — it declares ${[...declared.keys()].join(", ")}`);
        continue;
      }
      // The second direction, and the one a forward-only check cannot see: the document exists and
      // is produced, and just does not agree about who writes it.
      if (d.stage !== s.name) {
        bad.push(`${where}: stage '${s.name}' produces ${d.name}, and ${d.name} says ` +
                 `${d.stage ? `stage '${d.stage}'` : "no stage"} writes it — the two halves of ` +
                 "the manifest name different stages for one document");
      }
    }

    // And the documents nothing claims. Not the mirror of the loop above: a document with no
    // `stage` field of its own is invisible to `catalog-stages.ts`'s "a document's declared stage is
    // a stage its flow has", which skips it, and to the forward resolution here, which only looks at
    // documents some stage already named.
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
