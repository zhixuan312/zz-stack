// A flow is a plugin that declares documents. zz-access is not one.
//
// Three layers, because reading the manifests says the catalog is in the right shape and
// nothing about which field the code branches on. So the real reader runs (manifestAt, isFlow,
// out of packages/catalog/dist), and the sites that cannot be run from here — the chain, the
// status tool, the gate's own manifest rule, the contract's prose — are read for the field they
// name.
//
// Every failure below says which of the three layers it came from.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isFlow, manifestAt } from "../packages/catalog/dist/index.js";

const fail: string[] = [];
const src = (p: string) => readFileSync(p, "utf8");

// 1. the manifests
const manifests: string[] = [];
const walk = (d: string): void => readdirSync(d).forEach((f) => {
  const p = join(d, f);
  if (statSync(p).isDirectory()) walk(p);
  else if (f === "flow.json") manifests.push(p);
});
walk("catalog");

for (const p of manifests) {
  const m = JSON.parse(src(p));
  const flow = Array.isArray(m.documents) && m.documents.length > 0;
  if (flow && !(Array.isArray(m.stages) && m.stages.length)) {
    fail.push(`manifest: ${p} declares documents but no stages — nothing produces them`);
  }
  // A stage that merely repeats the entry skill, with no documents, is the phantom.
  if (!flow && Array.isArray(m.stages) && m.stages.length === 1
      && m.stages[0].name === m.entry) {
    fail.push(`manifest: ${p} declares a single stage repeating its entry and no documents — remove it`);
  }
}
// The two known answers, asserted by name so a regression is loud.
const byName = Object.fromEntries(manifests.map((p) => [JSON.parse(src(p)).name, p]));
const manifestOf = (n: string) => JSON.parse(src(byName[n]));
const docs = (n: string) => (manifestOf(n).documents || []).length;
if (byName["zz-access"] && docs("zz-access") !== 0) fail.push("manifest: zz-access declares documents; it is not a flow");
// The phantom is deleted, not merely undeclared as a flow: a stage kept "for the stepper" is
// the same package shape under a new justification.
if (byName["zz-access"] && (manifestOf("zz-access").stages || []).length) {
  fail.push("manifest: zz-access declares stages again — the phantom is back");
}
// Control: sdlc-flow must still be a flow, or the test is passing for the wrong reason.
if (byName["sdlc-flow"] && docs("sdlc-flow") === 0) fail.push("manifest: sdlc-flow lost its documents");

// 2. the real classifier, run
// isFlow is the one predicate the platform classifies with. Run it over every manifest on the
// shelf and hold it to `documents.length > 0` — the assertion the manifest layer cannot make,
// because it is about the code.
for (const p of manifests) {
  const m = manifestAt(p);
  if (!m.manifest) { fail.push(`classifier: ${p} ${m.why}`); continue; }
  const expected = (JSON.parse(src(p)).documents || []).length > 0;
  if (isFlow(m.manifest) !== expected) {
    fail.push(`classifier: isFlow(${p}) is ${isFlow(m.manifest)} and the manifest declares ` +
              `${(JSON.parse(src(p)).documents || []).length} document(s) — the classifier is ` +
              "not reading `documents`");
  }
}
// Guarded on the manifest resolving: a refused manifest is null and asking isFlow about it
// would throw, reporting a stack trace where the loop above has already reported the sentence
// that says what is wrong.
const classifies = (n: string) => (byName[n] ? manifestAt(byName[n]).manifest : null);
const zzAccess = classifies("zz-access");
const sdlcFlow = classifies("sdlc-flow");
if (zzAccess && isFlow(zzAccess)) fail.push("classifier: isFlow says zz-access is a flow");
if (sdlcFlow && !isFlow(sdlcFlow)) {
  fail.push("classifier: isFlow says sdlc-flow is not a flow — the control failed");
}

// And the refusal, through the same reader. Written to a temp directory outside the
// repository: a fixture left in the tree is a manifest the catalog would then load.
const tmp = mkdtempSync(join(tmpdir(), "zz-flow-classification-"));
try {
  const at = (name: string, manifest: Record<string, unknown>) => {
    const f = join(tmp, name);
    writeFileSync(f, JSON.stringify(manifest));
    return manifestAt(f);
  };
  // documents with nothing to produce them is refused, and the refusal names the field.
  const orphan = at("orphan.json", {
    name: "orphan", entry: "orphan",
    documents: [{ name: "spec.md", sections: ["Context"] }],
  });
  if (orphan.manifest) {
    fail.push("refusal: a manifest declaring documents and no stages was accepted");
  } else if (!/stages/.test(orphan.why)) {
    fail.push(`refusal: documents-without-stages was refused without naming \`stages\` — "${orphan.why}"`);
  }
  // Control: stages with no documents is an ordinary non-flow package, and zz-access is
  // exactly this shape.
  const surface = at("surface.json", {
    name: "surface", entry: "surface",
    stages: [{ name: "surface", produces: "nothing" }],
  });
  if (!surface.manifest) {
    fail.push(`refusal: a package with stages and no documents was refused — "${surface.why}"; ` +
              "that is a legal non-flow package");
  } else if (isFlow(surface.manifest)) {
    // The case the shelf cannot make. Every manifest in the catalog answers `documents` and
    // `stages` the same way, so running the classifier over the shelf alone cannot tell the two
    // rules apart: an isFlow reading `stages` passes every assertion above. This fixture is the
    // only shape that discriminates.
    fail.push("classifier: isFlow says a package with stages and no documents is a flow — " +
              "it is reading `stages`, not `documents`");
  }
  const governed = at("governed.json", {
    name: "governed", entry: "governed",
    stages: [{ name: "governed", produces: "spec.md" }],
    documents: [{ name: "spec.md", sections: ["Context"], stage: "governed" }],
  });
  if (!governed.manifest) {
    fail.push(`refusal: a manifest declaring both was refused — "${governed.why}"`);
  } else if (!isFlow(governed.manifest)) {
    fail.push("classifier: isFlow says a package declaring documents is not a flow");
  }
  // Control: neither field at all is legal too.
  const bare = at("bare.json", { name: "bare", entry: "bare" });
  if (!bare.manifest) {
    fail.push(`refusal: a package with neither stages nor documents was refused — "${bare.why}"`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// 3. the sites that classify, read for the field they name
// Each entry: file, a pattern that must be there, a pattern that must not, and why.
const sites: [string, RegExp, RegExp, string][] = [
  ["packages/catalog/src/index.ts", /\.filter\(\(e\) => isFlow\(e\.manifest\)\)/,
   /\(e\.manifest\.stages/,
   "governingFlows must ask isFlow, not rebuild the test"],
  ["packages/catalog/src/index.ts", /if \(isFlow\(m\) && !\(m\.stages\?\.length \?\? 0\)\)/,
   /\(m\.documents\?\.length \?\? 0\) > 0 &&/,
   "manifestAt enforces the obligation `documents` creates, so it must ASK isFlow — an " +
   "inline copy of the predicate one file from the classifier is how the old rule came to " +
   "have four spellings"],
  ["services/gateway/src/console/catalog.ts", /flow: isFlow\(e\.manifest\)/,
   /flow: \(?e\.manifest\.stages/,
   "the console must carry the declaration, not let the reader infer it from an empty `stages`"],
  ["services/gateway/src/console/shared.ts", /if \(manifest && isFlow\(manifest\)\) \{/,
   /if \(manifest\?\.documents\?\.length\) \{/,
   "an initiative gets a stepper, a gate list and a position only when its governing package " +
   "is a flow — the same question, asked of the classifier"],
  ["services/zz-core/src/chain.ts", /if \(m && isFlow\(m\)\) chain = deriveChain/,
   /if \(m\?\.documents\)? ?\??\.?(length)?\) chain = deriveChain/,
   "a chain IS a flow's discipline over its documents, so chainForFlow asks the classifier " +
   "rather than re-deriving it — and a bare `documents` test is truthy on `[]`, which " +
   "resolves a NAMED chain with nothing in it"],
  ["services/zz-core/src/tools/initiative-status.ts", /if \(docs\.length === 0\) \{/,
   /if \(!chain\.name && docs\.length === 0\)/,
   "initiative_status must refuse to compute a next move over an empty document chain, " +
   // NOT A TOOL: `close` is the `next_move.action` verb this refusal prevents, not a call.
   "however the chain was resolved — otherwise it answers `close` naming no document"],
  ["scripts/gate/checks/catalog-manifest.ts", /documents && !stages/, /m\.entry && !stages/,
   "the gate's manifest rule must refuse documents-without-stages, and must no longer " +
   "refuse an entry that declares no stages"],
];
for (const [file, must, mustNot, why] of sites) {
  const text = src(file);
  if (!must.test(text)) fail.push(`site: ${file} no longer matches ${must} — ${why}`);
  if (mustNot.test(text)) fail.push(`site: ${file} still matches ${mustNot} — ${why}`);
}

// ARCHITECTURE.md is the ruler, so it must state the rule the sites above enforce.
//
// DELIBERATE: a document only, never a code comment. The sites loop above asserts the rule at
// every place code decides it; asserting a sentence in a .ts file makes a comment load-bearing
// and costs an unwrapper to survive a rewrap.
const RULER = "ARCHITECTURE.md";
const RULE = /\*\*A package is a flow if and only if it declares `documents`\.\*\*/;
if (!RULE.test(src(RULER))) {
  fail.push(`prose: ${RULER} is the ruler and still states the replaced rule`);
}

// zz-access has no stages, and nothing may quietly require one back. The packager reads
// `entry`, and the console's stepper walks an empty list. Proven by building the
// package the gateway serves for zz-access and checking it still carries its entry skill.
try {
  // A separate process, because CATALOG_DIR is read once when @zz/catalog loads and this file
  // has already loaded it. The child gets the working tree's catalog/ instead of the image's
  // /catalog, which is what makes the walk runnable outside a container.
  const out = execFileSync("node", ["--input-type=module", "-e",
    'import { catalogEntry } from "./packages/catalog/dist/index.js";' +
    'const e = catalogEntry("zz-access", true);' +
    'console.log(JSON.stringify({ found: !!e, stages: (e?.manifest.stages ?? []).length,' +
    '                             entry: e?.manifest.entry ?? null }));',
  ], { encoding: "utf8", env: { ...process.env, ZZ_CATALOG_DIR: "catalog" } });
  const got = JSON.parse(out.trim().split("\n").pop()!);
  if (!got.found) fail.push("zero-stage: zz-access no longer resolves through the catalog reader");
  if (got.stages !== 0) fail.push(`zero-stage: zz-access resolves with ${got.stages} stage(s)`);
  if (got.entry !== "zz-access") fail.push("zero-stage: zz-access lost its entry, so its agent has no door");
} catch (err) {
  fail.push(`zero-stage: reading zz-access through the catalog threw — ` +
            `${err instanceof Error ? err.message : String(err)}`);
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("flow classification: ok");
