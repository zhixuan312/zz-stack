#!/usr/bin/env node
/**
 * A spec is approved on its phase outline and on core statements a spike actually tested.
 *
 * Drives the real `specApprovalRefusal` — the predicate `document_approve` calls at
 * services/zz-core/src/tools/initiative-acts.ts — over a fixture store resolved through the real
 * `chainFor` and the real sdlc-flow manifest, with no typed-service key, so the deterministic
 * rules are what is exercised; the reading-dependent branches are driven by writing the store
 * copies of the readings, which is what the approval itself writes.
 *
 *   1. refused: no `## Phase outline`, an outline naming no phase, an AC no phase covers, an AC
 *      the spec does not declare; no `## Core statements`, a row with no evidence locator, no
 *      quote, no "if false", a bad status, a `fails` row nothing settles
 *   2. passes: a complete spec; a `fails` row settled by a design change or by a stakeholder source
 *   3. the readings of a `holds` row: `no` refuses, `unclear` asks to sharpen, `unclear` again on
 *      new evidence goes to the stakeholder, `unavailable` passes and says so
 *   4. a flow that declares neither section is untouched
 *   5. the replay of 2026-09-24-plugin-eval-next-version: its design rested on candidates being
 *      built inside the zz-core process. The spike, run on 2026-09-26 against the released image
 *      (read-only, no network), is quoted below; written as a core statement it comes out
 *      `fails`, and the spec is refused until the design changes or the stakeholder decides.
 *
 * Run: node checks/spec-gate.ts   (also run by scripts/gate.ts)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

process.env.ZZ_CATALOG_DIR = join(process.cwd(), "catalog");
delete process.env.TYPESAFE_API_KEY;

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { specApprovalRefusal } = await load("services/zz-core/dist/spec-gate.js");
const acc = await load("services/zz-core/dist/review-acceptance.js");
const rec = await load("services/zz-core/dist/initiative-record.js");
const { chainFor } = await load("services/zz-core/dist/chain.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const root = mkdtempSync(join(tmpdir(), "spec-gate-"));
const doc = (fields: Record<string, string>, body: string) =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${body}\n`;

const ACS = "## Stakeholders & Work\n\n- [ ] **AC-1.1** An intake email becomes a case. (FR-1)\n" +
            "- [ ] **AC-2.1** A case can be closed. (FR-2)\n\n";
const OUTLINE = "## Phase outline\n\n- **Phase 1 — Skeleton:** an email becomes a case end to end. Covers AC-1.1.\n" +
                "- **Phase 2 — Closing:** a case closes. Covers AC-2.1.\n\n";
const HEAD = "| ID | Statement | If false | Status | Evidence | Note |\n|---|---|---|---|---|---|\n";
const HOLDS = "| CS-1 | The mail relay delivers to the intake queue. | No email becomes a case. | holds | " +
              "run:relay-spike — `delivered 1/1 to intake` | |\n";
const statements = (...rows: string[]) => `## Core statements\n\n${HEAD}${rows.join("")}\n`;
const SPEC = "# Spec\n\n" + ACS + OUTLINE + statements(HOLDS);

let n = 0;
/** A fresh sdlc-flow initiative; returns what approving `body` as its spec answers. */
function fresh(): string {
  const name = `2026-09-26-spec-${++n}`;
  rec.recordOpen(root, name, "sdlc-flow", "ada@zz.test");
  mkdirSync(join(root, name, "sources"), { recursive: true });
  return name;
}
const specApproval = async (name: string, body: string) => {
  const chain = chainFor(root, `${name}/x.md`);
  is(chain.name === "sdlc-flow", `${name}: the fixture did not resolve to sdlc-flow — every assertion would pass on nothing`);
  const content = doc({ title: "Spec", flow: "sdlc-flow" }, body);
  writeFileSync(join(root, name, "spec.md"), content);
  return specApprovalRefusal(root, chain, `${name}/spec.md`, content, "ada@zz.test") as
    Promise<{ refusal: string | null; note: string }>;
};
const refused = async (body: string, mentions: RegExp, why: string, name = fresh()) => {
  const r = await specApproval(name, body);
  is(r.refusal && mentions.test(r.refusal), `${why} — got ${r.refusal ?? "an approval"}`);
};
const stakeholder = (name: string, text: string) =>
  writeFileSync(join(root, name, "sources", `2026-09-26-decision-${text.length}.md`),
    doc({ title: "Decision", supports: "spec.md", added_at: "2026-09-26T00:00:00.000Z" }, text));

try {
  // 1. The deterministic refusals.
  await refused("# Spec\n\n" + ACS + statements(HOLDS), /no `## Phase outline`/, "a spec with no Phase outline was approved");
  await refused("# Spec\n\n" + ACS + "## Phase outline\n\nWe will see.\n\n" + statements(HOLDS),
    /names no phase/, "an outline naming no phase was approved");
  await refused("# Spec\n\n" + ACS + OUTLINE.replace(" Covers AC-2.1.", "") + statements(HOLDS),
    /no phase covers AC-2\.1/, "a spec whose AC-2.1 no phase covers was approved");
  await refused("# Spec\n\n" + ACS + OUTLINE.replace("AC-2.1.", "AC-2.1, AC-9.9.") + statements(HOLDS),
    /AC-9\.9, which the spec does not declare/, "an outline naming an undeclared AC was approved");
  await refused("# Spec\n\n" + ACS + OUTLINE, /no `## Core statements`/, "a spec with no Core statements was approved");
  await refused("# Spec\n\n" + ACS + OUTLINE + "## Core statements\n\nAll fine.\n",
    /no `CS-N` row/, "a Core statements section with no row was approved");
  await refused(SPEC.replace("run:relay-spike — ", "we believe so — "), /CS-1's evidence names no kind-prefixed locator/,
    "a statement with no evidence locator was approved");
  await refused(SPEC.replace("`delivered 1/1 to intake`", "it worked"), /CS-1 quotes no output/,
    "a statement quoting no output was approved");
  await refused(SPEC.replace("| No email becomes a case. |", "| |"), /what breaks if it is false/,
    "a statement not saying what breaks was approved");
  await refused(SPEC.replace("| holds |", "| probably |"), /status "probably"/, "a statement with a bad status was approved");
  const FAILS = HOLDS.replace("| holds |", "| fails |").replace("delivered 1/1", "delivered 0/1");
  await refused("# Spec\n\n" + ACS + OUTLINE + statements(FAILS), /CS-1 fails and nothing settles it/,
    "a failing statement nothing settled was approved");
  await refused("# Spec\n\n" + ACS + OUTLINE + statements(FAILS.replace("| holds |", "| partial |").replace("| fails |", "| partial |")),
    /CS-1 holds only in part/, "a partial statement nothing settled was approved");

  // 2. What passes.
  const ok = await specApproval(fresh(), SPEC);
  is(ok.refusal === null, `a complete spec was refused: ${ok.refusal}`);
  is(/1 hold, 0 fail/.test(ok.note) && /unavailable for CS-1/.test(ok.note),
     `an approval with no typed service did not say so: ${ok.note}`);
  const redesigned = await specApproval(fresh(), "# Spec\n\n" + ACS + OUTLINE +
    statements(FAILS.replace("| |\n", "| resolved-by-design-change: intake polls the mailbox instead |\n")));
  is(redesigned.refusal === null, `a failing statement the design answered was refused: ${redesigned.refusal}`);
  const decided = fresh();
  stakeholder(decided, "CS-1 stays open: we accept manual forwarding for the pilot.");
  const vouched = await specApproval(decided, "# Spec\n\n" + ACS + OUTLINE + statements(FAILS));
  is(vouched.refusal === null, `a failing statement the stakeholder decided was refused: ${vouched.refusal}`);

  // 3. The readings of a holds row, written where the approval writes them.
  const digestOf = (evidence: string) => acc.rowDigest("The mail relay delivers to the intake queue.", evidence);
  const EVIDENCE = "run:relay-spike — `delivered 1/1 to intake`";
  const seed = (name: string, readings: Array<[string, string]>) =>
    acc.writeAcceptanceCache(root, name, "spec.statements.md", { "CS-1": readings.map(([evidence, reading]) =>
      ({ digest: digestOf(evidence), reading, probability: reading === "no" ? 0.1 : 0.5, reason: null, asked_at: "2026-09-26" })) });
  const no = fresh(); seed(no, [[EVIDENCE, "no"]]);
  await refused(SPEC, /CS-1: evidence_relation reads its evidence as not supporting/, "a `no` reading was approved", no);
  const unclear = fresh(); seed(unclear, [[EVIDENCE, "unclear"]]);
  await refused(SPEC, /evidence_relation is unclear \(p=0\.50\) — sharpen/, "a first `unclear` was approved", unclear);
  const again = fresh(); seed(again, [["run:relay-spike — `ok`", "unclear"], [EVIDENCE, "unclear"]]);
  await refused(SPEC, /unclear a second time.*the stakeholder decides/, "a second `unclear` went past the stakeholder", again);
  stakeholder(again, "CS-1 is accepted on the relay log as it stands.");
  is((await specApproval(again, SPEC)).refusal === null, "a second `unclear` the stakeholder accepted was refused");

  // 4. A flow that does not declare the sections is untouched.
  const free = "2026-09-26-freeform";
  mkdirSync(join(root, free), { recursive: true });
  const none = await specApprovalRefusal(root, chainFor(root, `${free}/x.md`), `${free}/spec.md`, "# Spec\n", "ada@zz.test");
  is(none.refusal === null && none.note === "", `a spec in a flow declaring neither section was held: ${none.refusal}`);

  // 5. The replay. The spike, run 2026-09-26 against the image 0.76.2 released:
  //   docker run --rm --network none --read-only --platform linux/amd64 --entrypoint sh \
  //     ghcr.io/zhixuan312/zz-stack:0.76.2 -c 'cd /repo; for p in .git catalog scripts/gate.ts; do
  //     [ -e "$p" ] && echo "present: $p" || echo "absent: $p"; done; git -C /repo rev-parse HEAD'
  //   -> absent: .git / absent: catalog / absent: scripts/gate.ts
  //   -> fatal: not a git repository (or any of the parent directories): .git
  const SPIKE = "run:docker run --read-only ghcr.io/zhixuan312/zz-stack:0.76.2 (repo checkout probe) — " +
    "`absent: .git`, `absent: catalog`, `absent: scripts/gate.ts`, " +
    "`fatal: not a git repository (or any of the parent directories): .git`";
  const replayAcs = "## Stakeholders & Work\n\n- [ ] **AC-32.1** Candidate replay demonstrates isolated checkout/data/runtime " +
    "and no residue in production profiles. (FR-32)\n- [ ] **AC-46.1** Candidate search/build/replay can proceed in " +
    "isolation before release approval without modifying the real target. (FR-46)\n\n";
  const replayOutline = "## Phase outline\n\n- **Phase 1 — Isolated candidates:** a candidate is built and replayed in " +
    "isolation. Covers AC-32.1, AC-46.1.\n\n";
  const CS1 = "| CS-1 | A candidate can be built and tested inside the zz-core process: the image carries a repo " +
    "checkout (`candidate_validate`: build/test). | candidate_validate has nothing to build from; FR-32 and FR-46 " +
    `need a build host outside zz-core. | fails | ${SPIKE} | |\n`;
  const replay = fresh();
  await refused("# Spec\n\n" + replayAcs + replayOutline + statements(CS1), /CS-1 fails and nothing settles it/,
    "the replayed spec was approved over the statement its own spike disproved", replay);
  // Had it been written `holds`, as the design assumed, the spike's own output is what the
  // reading answers; a `no` there refuses it just the same.
  const assumed = fresh();
  acc.writeAcceptanceCache(root, assumed, "spec.statements.md", { "CS-1": [{ digest: acc.rowDigest(
    "A candidate can be built and tested inside the zz-core process: the image carries a repo checkout " +
    "(`candidate_validate`: build/test).", SPIKE), reading: "no", probability: 0.04, reason: null, asked_at: "2026-09-26" }] });
  await refused("# Spec\n\n" + replayAcs + replayOutline + statements(CS1.replace("| fails |", "| holds |")),
    /CS-1: evidence_relation reads its evidence as not supporting/, "the replayed statement written as holds was approved", assumed);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (fail.length) {
  console.error(`spec-gate: ${fail.length} failure(s)\n  - ${fail.join("\n  - ")}`);
  process.exit(1);
}
console.log("spec-gate: a spec is approved on a phase outline covering every AC and on core statements a spike tested");
