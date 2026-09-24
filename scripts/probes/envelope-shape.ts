/**
 * What the platform actually stamps on a document, for a manifest document and for one the
 * manifest does not declare. Run by the gate.
 *
 * The second case is the one worth testing: `learnings.md` belongs to no flow — the handover
 * is the platform's step, appended below every manifest — so it takes a different path
 * through stampEnvelope than every document a flow declares, and that path has to stamp the
 * date itself.
 *
 * stampEnvelope is not exported, so its body is brace-matched out, evaluated with its three
 * collaborators injected, and asked what it does to a document. A regex over the source would
 * test the spelling rather than the rule. Non-empty stdout reports a failure.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ENVELOPE_BLOCK, parseEnvelope } from "@zz/contracts";

/** A caught value is never typed as an Error — narrow the shape actually being read rather
 *  than assume it. `unknown?.message` narrows to `{}`, which has no properties at all. */
function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as Record<string, unknown>).message;
    if (m !== undefined && m !== null) return String(m);
  }
  return String(err);
}

const root = process.argv[2];
// Every file in zz-core/src, not one path: a probe keyed to the file stampEnvelope lives in
// today reports "nothing was checked" the day it moves.
const src = readdirSync(join(root, "services/zz-core/src"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => readFileSync(join(root, "services/zz-core/src", f), "utf8"))
  .join("\n");
const bad: string[] = [];

/** stampEnvelope's body, brace-matched and stripped of the annotations JS has no use for. */
function body() {
  const at = src.indexOf("function stampEnvelope(");
  if (at < 0) return null;
  let depth = 0;
  const open = src.indexOf("{", at);
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      return src.slice(open + 1, i)
        .replace(/:\s*string\[\]/g, "").replace(/:\s*string \| undefined/g, "")
        .replace(/:\s*string/g, "");
    }
  }
  return null;
}

const source = body();
if (!source) {
  process.stdout.write("stampEnvelope is no longer where this can read it — nothing was checked");
  process.exit(0);
}

const TODAY = "2026-01-02";
let stamp;
try {
  stamp = new Function("parseEnvelope", "ENVELOPE_BLOCK", "isoToday", "chain", "relPath", "content", source)
    .bind(null, parseEnvelope, ENVELOPE_BLOCK, () => TODAY);
} catch (e) {
  process.stdout.write(`stampEnvelope could not be evaluated: ${errMessage(e)}`);
  process.exit(0);
}

// The manifest's own shape, including `documents` with each entry's gate. Two declared
// documents differing only in `gate` and deliberately sharing a role, because the manifest
// decides adjudication per document — neither the role nor the filename may be what the
// stamp keys on.
const chain = {
  name: "ops-flow",
  documents: [
    { name: "spec.md", role: "agreement", gate: true },
    { name: "spec-audit.md", role: "agreement" },
  ],
  docs: new Set(["spec.md", "spec-audit.md"]),
  roles: { "spec.md": "agreement", "spec-audit.md": "agreement" },
};
const env = (doc: string) => parseEnvelope(doc);

// A document the manifest declares: the flow, the role, the gate lifecycle, and the date.
{
  const out = stamp(chain, "i/spec.md", "# Spec\n\nbody\n");
  const e = env(out);
  for (const [k, want] of [["flow", "ops-flow"], ["type", "agreement"],
                           ["status", "draft"], ["version", "1"], ["updated_at", TODAY]]) {
    if (e[k] !== want) bad.push(`a declared document got ${k}=${JSON.stringify(e[k])}, wanted ${JSON.stringify(want)}`);
  }
}

// A document the manifest declares without a gate: the flow, the role, the version and the
// date, but no status, because a status records a gate verdict nobody was asked for.
// Conditioning `status` on "the manifest declares this document" is one predicate too wide.
//
// `version` is the control, and it stops this being satisfied by stamping nothing: version is
// provenance rather than a verdict, so an ungated document still carries it.
{
  const out = stamp(chain, "i/spec-audit.md", "# Audit\n\nbody\n");
  const e = env(out);
  if (e.status !== undefined) {
    bad.push(`a declared but UNGATED document was stamped status=${JSON.stringify(e.status)} — ` +
             "a status records a gate verdict, and this document's manifest declares no gate");
  }
  for (const [k, want] of [["flow", "ops-flow"], ["type", "agreement"],
                           ["version", "1"], ["updated_at", TODAY]]) {
    if (e[k] !== want) {
      bad.push(`a declared but ungated document got ${k}=${JSON.stringify(e[k])}, wanted ${JSON.stringify(want)} — ` +
               "an ungated document still carries its provenance and its version");
    }
  }
}

// A document no manifest declares — learnings.md. It gets the date and nothing else: status
// and version belong to a gate lifecycle it is not in, and type comes from a role it was
// never given.
{
  const out = stamp(chain, "i/learnings.md", "# Learnings\n\nbody\n");
  const e = env(out);
  if (e.updated_at !== TODAY) {
    bad.push(`a document the manifest does not declare got updated_at=${JSON.stringify(e.updated_at)} — ` +
             "it is the file a team keeps when they walk away from us, and it had no date at all");
  }
  for (const k of ["status", "version", "type"]) {
    if (e[k] !== undefined) {
      bad.push(`a document the manifest does not declare was stamped ${k}=${JSON.stringify(e[k])} — ` +
               "the platform inventing a fact about a document it does not govern");
    }
  }
}

// updated_at is overwritten, because the failure there is a confidently wrong date rather
// than an absent one.
{
  const out = stamp(chain, "i/spec.md", "---\nflow: ops-flow\nupdated_at: 26-08-2026\n---\n\n# Spec\n");
  if (env(out).updated_at !== TODAY) {
    bad.push(`a stale updated_at survived the stamp (${JSON.stringify(env(out).updated_at)})`);
  }
}

// flow is add-only: the first document's `flow:` is the input that resolves the chain, so
// overwriting it from the chain it produced turns a caller's declaration into something else.
//
// Asserted on the lines, not on the value parseEnvelope returns: the stamp puts what it adds
// above the existing frontmatter and parseEnvelope takes the last value of a repeated key, so
// a missing guard leaves the right value and a second `flow:` line above it.
{
  const out = stamp(chain, "i/spec.md", "---\nflow: declared-by-caller\n---\n\n# Spec\n");
  if (env(out).flow !== "declared-by-caller") {
    bad.push(`the caller's own flow declaration was overwritten with ${JSON.stringify(env(out).flow)}`);
  }
  const keys = [...(ENVELOPE_BLOCK.exec(out)?.[1] ?? "").matchAll(/^([A-Za-z0-9_-]+):/gm)].map((m) => m[1]);
  const twice = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (twice.length) {
    bad.push(`the stamp wrote ${[...new Set(twice)].join(", ")} twice — an envelope that states ` +
             "a field two ways is resolved by whichever line a reader happens to take");
  }
}

// type is set, not merely added: the index stores what the file says, so a type the manifest
// did not give makes a search by the manifest's role miss the document it describes.
{
  const out = stamp(chain, "i/spec.md", "---\nflow: ops-flow\ntype: something-else\n---\n\n# Spec\n");
  if (env(out).type !== "agreement") {
    bad.push(`a wrong type survived the stamp (${JSON.stringify(env(out).type)}), so the index ` +
             "records a role the manifest does not give this document");
  }
}

process.stdout.write(bad.join("; "));
