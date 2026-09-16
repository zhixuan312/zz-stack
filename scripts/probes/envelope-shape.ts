/**
 * What the platform actually stamps on a document, for a manifest document and for one the
 * manifest does not declare. Run by the gate.
 *
 * The second case is the one worth testing: `learnings.md` belongs to no flow — the handover
 * is the platform's step, appended below every manifest — so it takes a different path
 * through stampEnvelope than every document a flow declares, and that path had no date in it
 * once the model stopped writing frontmatter.
 *
 * IT RUNS THE FUNCTION NOW. This asserted with regexes over the source, and admitted why:
 * "stampEnvelope is not exported, so this exercises the SHAPE through the source's own
 * rules". Two things were wrong with that.
 *
 * The slice was not the function. `src.slice(indexOf("function stampEnvelope("),
 * indexOf("function persistDocument("))` spans 953 lines — two dozen unrelated functions —
 * so every assertion was answered by whichever of them happened to contain the text. The
 * comment that used to sit here worried about exactly this and guarded the wrong half: it
 * checked that both markers EXIST and are ordered, which they are, while the region between
 * them was already a third of the file.
 *
 * And a regex over source tests the spelling, not the rule. gate.ts records the same lesson
 * about the acting-team check: "the earlier version tested for the literal
 * `every.includes(stored)` and failed the moment the rule moved, while the property it names
 * still held perfectly."
 *
 * So the body is brace-matched out, evaluated with its three collaborators injected, and
 * asked what it does to a document. Non-empty stdout is how this probe reports a failure.
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
// ZZ-CORE, NOT ONE FILE IN IT. stampEnvelope moved into write-guards.ts when the pure rules
// were split out of a 6,000-line server.ts, and a probe keyed to that one path reported
// "nothing was checked" — which is the honest failure, and still a failure.
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

// THE MANIFEST'S OWN SHAPE, including `documents` with each entry's gate. This fixture used
// to carry only `docs` and `roles`, which is what a Chain looked like before the manifest's
// document list reached it — and a stamp that reads `gate` cannot be tested by a chain that
// has none.
//
// Two declared documents, differing ONLY in `gate`, and deliberately sharing a role: the rule
// is that the MANIFEST decides adjudication, per flow and per document, so neither the role
// nor the filename may be what the stamp keys on.
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

// A document the manifest DECLARES: the flow, the role, the gate lifecycle, and the date.
{
  const out = stamp(chain, "i/spec.md", "# Spec\n\nbody\n");
  const e = env(out);
  for (const [k, want] of [["flow", "ops-flow"], ["type", "agreement"],
                           ["status", "draft"], ["version", "1"], ["updated_at", TODAY]]) {
    if (e[k] !== want) bad.push(`a declared document got ${k}=${JSON.stringify(e[k])}, wanted ${JSON.stringify(want)}`);
  }
}

// A document the manifest DECLARES WITHOUT A GATE. It gets the flow, the role, the version
// and the date — but NO status, because a status records a gate verdict and this document's
// manifest never asked anyone for one. An ungated document and a source are information:
// provenance and a version, and no verdict.
//
// This is the path the stamp used to get wrong. It conditioned `status` on "the manifest
// declares this document", which is one predicate too wide — a manifest declares gated and
// ungated documents alike. Measured on the deployment before the fix: 17 live documents
// (explore.md, spec-audit.md, plan-audit.md) carried a verdict no manifest asked for, and an
// ungated document could not be rewritten by document_write at all, because ownershipCheck
// read the fresh envelope's absent status against the phantom one on disk as an attempt to
// remove a platform-owned field.
//
// `version` is the control, and it is what stops this being satisfied by stamping nothing:
// version is provenance rather than a verdict, so an ungated document still carries it.
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

// A document NO manifest declares — learnings.md. It gets the date and nothing else: status
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

// updated_at is OVERWRITTEN, because the failure there is a confidently wrong date rather
// than an absent one: a run stamped every document two days early and nothing caught it.
{
  const out = stamp(chain, "i/spec.md", "---\nflow: ops-flow\nupdated_at: 26-08-2026\n---\n\n# Spec\n");
  if (env(out).updated_at !== TODAY) {
    bad.push(`a stale updated_at survived the stamp (${JSON.stringify(env(out).updated_at)})`);
  }
}

// flow is ADD-ONLY: the first document's `flow:` is the INPUT that resolves the chain, so
// overwriting it from the chain it produced could only turn a caller's declaration into
// something else.
//
// ASSERTED ON THE LINES, not on the value parseEnvelope returns. The value survives either
// way — stampEnvelope puts what it adds ABOVE the existing frontmatter and parseEnvelope takes
// the LAST value of a repeated key, so removing the guard leaves the caller's declaration
// winning and adds a second `flow:` line above it. The document then states its flow twice,
// which every reader of it resolves by luck of position. Found by a mutation that removed the
// guard and did not fail.
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

// type is SET, not merely added. ops-flow declares guide.md's role as `verification` and every
// guide on the deployment carries `type: guide`, because a template once put it there — and
// the index stores what the file says, so a search by the manifest's role misses the document
// the manifest is describing.
{
  const out = stamp(chain, "i/spec.md", "---\nflow: ops-flow\ntype: something-else\n---\n\n# Spec\n");
  if (env(out).type !== "agreement") {
    bad.push(`a wrong type survived the stamp (${JSON.stringify(env(out).type)}), so the index ` +
             "records a role the manifest does not give this document");
  }
}

process.stdout.write(bad.join("; "));
