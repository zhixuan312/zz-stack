/**
 * Stages 1–6 of zz-plugin-eval, each in a conversation of its own, each following its stage
 * skill's own instructions in order.
 *
 * The rule every stage keeps: an argument is the operator's (the initiative, the plugin name), or
 * a value a call made IN THIS STAGE returned, or a value read back from the initiative
 * (`initiative_status`, a document). Nothing crosses a stage boundary in a variable. Where a stage
 * could not obtain an id that way, the walk fails there — that is the bug it exists to find.
 *
 * Every stage opens the way the flow's entry skill routes: load zz-platform and zz-plugin-eval,
 * ask `initiative_status` for `next_move`, check it names this stage, then load the stage skill.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EVAL_STATE_ENUMS } from "@zz/contracts";

import { Conversation, obj, str, type Reply } from "./doors.ts";
import { live } from "./stack.ts";

export interface Walk { readonly url: string; readonly pat: string; readonly initiative: string; readonly plugin: string }

/** What `next_move` must say for a stage to be the one the flow routes to next. */
type Route = { action: string; stage?: string; document?: string };

export async function enter(w: Walk, stage: string, route: Route): Promise<{ c: Conversation; status: Reply }> {
  const c = new Conversation(w.url, w.pat, stage);
  await c.skill("zz-platform");
  await c.skill("zz-plugin-eval");
  const status = await c.call("core", "initiative_status", { initiative: w.initiative },
    { note: (r) => `next_move ${JSON.stringify(r.next_move)}` });
  const next = obj(status, "next_move", "initiative_status");
  const matches = next.action === route.action
    && (route.stage === undefined || next.stage === route.stage)
    && (route.document === undefined || next.document === route.document);
  if (!matches) {
    throw new Error(`${stage}: initiative_status routes to ${JSON.stringify(next)}, not ${JSON.stringify(route)} — ` +
      "a fresh conversation following the entry skill would not reach this stage");
  }
  await c.skill(stage);
  return { c, status };
}

/** One id a record stage wrote, read back the way a fresh conversation reads it. */
export function recorded(status: Reply, stage: string, id: string): string {
  const records = obj(status, "records", "initiative_status");
  const rec = records[stage];
  if (!rec || typeof rec !== "object") throw new Error(`initiative_status records nothing for ${stage}: ${JSON.stringify(records)}`);
  return str(rec as Reply, id, `initiative_status records.${stage}`);
}

export async function identify(w: Walk): Promise<string> {
  const { c } = await enter(w, "zz-plugin-identify", { action: "run_stage", stage: "zz-plugin-identify" });
  const s = await c.call("eval", "plugin_locate", { plugin: w.plugin, idempotency_key: c.key("locate"), initiative: w.initiative },
    { note: (r) => `subject ${String(r.subject_version_id)} ${String(r.plugin)}@${String(r.declared_version)} digest ${String(r.content_digest).slice(0, 12)}` });
  if (s.record_refused) throw new Error(`plugin_locate did not record: ${String(s.record_refused)}`);
  return str(s, "subject_version_id", "plugin_locate");
}

export async function observe(w: Walk): Promise<{ snapshot: string; usable: number }> {
  const { c, status } = await enter(w, "zz-plugin-observe", { action: "run_stage", stage: "zz-plugin-observe" });
  const subject = recorded(status, "zz-plugin-identify", "subject_version_id");
  const p = await c.call("eval", "plugin_profile", {
    subject_version_id: subject, evidence_window: { last_runs: 100 }, idempotency_key: c.key("profile"), initiative: w.initiative,
  }, { note: (r) => `snapshot ${String(r.observation_snapshot_id)} usable ${String(r.usable_run_count)}/${String(r.total_run_count)} sufficient ${String(r.sufficient_for_judging)}` });
  const usable = Number(p.usable_run_count ?? 0);
  if (usable < 5) throw new Error(`plugin_profile found ${usable} usable runs; the walk seeded enough for five: ${JSON.stringify(p).slice(0, 600)}`);
  return { snapshot: str(p, "observation_snapshot_id", "plugin_profile"), usable };
}

export async function discover(w: Walk): Promise<number> {
  const { c, status } = await enter(w, "zz-plugin-discover", { action: "run_stage", stage: "zz-plugin-discover" });
  const snapshot = recorded(status, "zz-plugin-observe", "observation_snapshot_id");
  const d = await c.call("eval", "failure_discover", { observation_snapshot_id: snapshot, idempotency_key: c.key("discover"), initiative: w.initiative },
    { note: (r) => `${Array.isArray(r.candidates) ? r.candidates.length : "?"} candidate(s)` });
  // The seeded runs carry refusals with no recorded text, which is what DISCOVER exists to find:
  // none found is the stage not working, not a quiet deployment.
  const found = Array.isArray(d.candidates) ? d.candidates.length : 0;
  if (!found) throw new Error(`failure_discover found no candidate in runs seeded with refusals: ${JSON.stringify(d).slice(0, 400)}`);
  return found;
}

/** The reference protocol for zz-core, the sample the define stage starts from, with DISCOVER's
 *  open candidates folded into its failure taxonomy. */
function protocolBody(version: number, open: readonly Reply[]): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(live, "catalog/zz/zz-plugin-eval/protocols/zz-core.json"), "utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("the reference protocol is not an object");
  const body = { ...(parsed as Record<string, unknown>) };
  body.version = version;
  const taxonomy = Array.isArray(body.failureTaxonomy) ? [...body.failureTaxonomy] : [];
  open.forEach((cand, i) => taxonomy.push({ key: `discovered_${i + 1}`, candidateId: cand.id, description: cand.description }));
  body.failureTaxonomy = taxonomy;
  return body;
}

const MODEL_BACKED = new Set(["bounded_semantic", "generative_critic"]);

export async function defineQualify(w: Walk): Promise<{ protocol: string; qualified: Record<string, string> }> {
  const { c, status } = await enter(w, "zz-plugin-define-qualify", { action: "resolve_branch", document: "protocol.md" });
  const subject = recorded(status, "zz-plugin-identify", "subject_version_id");
  const read = await c.call("eval", "protocol_read", { subject_version_id: subject, initiative: w.initiative },
    { note: (r) => `protocol_action ${String(r.protocol_action)} open_candidates ${Array.isArray(r.open_candidates) ? r.open_candidates.length : "none"}` });
  if (read.protocol_action !== "create") throw new Error(`a fresh deployment's first protocol_read answered ${String(read.protocol_action)}`);
  const open = Array.isArray(read.open_candidates) ? read.open_candidates as Reply[] : [];
  const body = protocolBody(1, open);
  const rec = await c.call("eval", "protocol_record", { subject_version_id: subject, protocol_body: body, idempotency_key: c.key("record") },
    { note: (r) => `protocol_version ${String(r.protocol_version_id)} digest ${String(r.content_digest).slice(0, 12)}` });
  const protocol = str(rec, "protocol_version_id", "protocol_record");
  const digest = str(rec, "content_digest", "protocol_record");
  const located = await c.call("eval", "plugin_locate", { plugin: w.plugin, idempotency_key: c.key("locate") });
  const dims = (body.dimensions as { key: string; weight: number; measures: { key: string; evaluatorType: string }[] }[]);
  const path = `${w.initiative}/protocol.md`;
  // One body: the edit below appends a revision note to it and changes nothing else.
  const sections = [
    "## The plugin under evaluation",
    `${w.plugin} ${String(located.declared_version)}, content digest ${String(located.content_digest)}; ` +
      `protocol version 1, content_digest ${digest}.`,
    "", "## What good means here",
    ...dims.map((d) => `- **${d.key}** (weight ${d.weight}): ${d.measures.map((m) => m.key).join(", ")}.`),
    "", "## The evidence each dimension reads",
    ...dims.flatMap((d) => d.measures.map((m) => `- ${m.key}: ${MODEL_BACKED.has(m.evaluatorType)
      ? "a qualified typed evaluator reading the artifact's text" : "a fact OBSERVE computed"}.`)),
    "",
  ];
  await c.call("core", "document_write", { path, content: sections.join("\n") });
  await c.call("core", "document_present", { path });
  await c.call("core", "document_approve", { path });
  // The new-version step, and the reason this walk exists in this phase: an approval seals the
  // revision it names, a caused change to the approved body (`document_edit`) files a NEW one
  // beside it as the next public version and moves `current_revision` to it, and the approved
  // revision stays on the record untouched. Nothing else in the tree exercises that, and the
  // deferred current-revision key, the two-table split and the one-time seal are all only true
  // together.
  const revised = await c.call("core", "document_edit", {
    path,
    content: [
      ...sections,
      "## Revision note",
      "The qualification thresholds this protocol is held to were read again before anything was",
      "scored, and nothing in it moved.",
      "",
    ].join("\n"),
    source_content: "The operator read the protocol back before approving it and changed nothing.",
    source_title: "Protocol re-read before affirmation",
    note: "re-read before qualification",
  }, { note: (r) => `edited: ${String(r.text ?? "").split("\n")[0]?.slice(0, 80)}` });
  // The receipt's first line says which version the change landed in: `edited: <path> — v2 (new version)`.
  if (!/^edited: \S+ — v2 \(new version\)$/m.test(String(revised.text ?? ""))) {
    throw new Error(`document_edit did not open a new version: ${String(revised.text ?? "").slice(0, 300)}`);
  }
  // Both revisions read back, each as itself: the revision just filed is the current one and is
  // DRAFT again — a revision returns the gate to a person — and the one the first approval
  // sealed is still there beside it, approved and untouched. An implementation that overwrote
  // the approved bytes, or that lost them when `current_revision` moved, fails here.
  const current = await c.call("core", "document_read", { path });
  const first = await c.call("core", "document_read", { path, version: 1 });
  const currentText = String(current.text ?? "");
  const firstText = String(first.text ?? "");
  if (!/version: 2/.test(currentText) || !/status: draft/.test(currentText)) {
    throw new Error(`the revision just filed did not read back as v2 draft: ${currentText.slice(0, 300)}`);
  }
  if (!/version: 1/.test(firstText) || !/status: approved/.test(firstText) || /revision_note/.test(firstText)) {
    throw new Error(`v1 did not read back as the revision the first approval sealed: ${firstText.slice(0, 300)}`);
  }
  await c.call("core", "document_present", { path });
  await c.call("core", "document_approve", { path });
  // And the seal landed on the revision the approval named: v2 is approved, and v1 is still
  // filed beside it rather than replaced by it.
  const sealed = String((await c.call("core", "document_read", { path })).text ?? "");
  if (!/version: 2/.test(sealed) || !/status: approved/.test(sealed)) {
    throw new Error(`the second approval did not seal v2: ${sealed.slice(0, 300)}`);
  }
  const kept = String((await c.call("core", "document_read", { path, version: 1 })).text ?? "");
  if (!/version: 1/.test(kept)) {
    throw new Error(`v1 is no longer filed after the second approval: ${kept.slice(0, 240)}`);
  }
  await c.call("eval", "protocol_affirm", { protocol_version_id: protocol, initiative: w.initiative, idempotency_key: c.key("affirm") });
  const qualified: Record<string, string> = {};
  for (const m of dims.flatMap((d) => d.measures).filter((m) => MODEL_BACKED.has(m.evaluatorType))) {
    // With `initiative`, as the define-qualify skill says: the state is what initiative_status
    // routes EVALUATE on, and without it every measure stays owed.
    const q = await c.call("eval", "evaluator_qualify", { protocol_version_id: protocol, measure_key: m.key, initiative: w.initiative, idempotency_key: c.key(`qualify-${m.key}`) },
      { note: (r) => `${m.key}: ${String(r.state)}` });
    qualified[m.key] = String(q.state);
  }
  // Every model-backed measure must reach the protocol's own bar, or EVALUATE scores with
  // qualification_met false and the walk would be checking a run nothing can establish.
  const ladder: readonly string[] = EVAL_STATE_ENUMS.qualificationState;
  const minimum = String((body.qualification as { boundedSemanticMinimum?: string } | undefined)?.boundedSemanticMinimum ?? "operationally_qualified");
  const short = Object.entries(qualified).filter(([, state]) => ladder.indexOf(state) < ladder.indexOf(minimum));
  if (!Object.keys(qualified).length || short.length) {
    throw new Error(`evaluator_qualify left ${short.map(([k, v]) => `${k} at ${v}`).join(", ") || "no measure qualified"}, below the protocol's ${minimum}`);
  }
  return { protocol, qualified };
}

export async function evaluate(w: Walk): Promise<{ evalRun: string; score: Reply }> {
  const { c, status } = await enter(w, "zz-plugin-evaluate", { action: "run_stage", stage: "zz-plugin-evaluate" });
  const subject = recorded(status, "zz-plugin-observe", "subject_version_id");
  const snapshot = recorded(status, "zz-plugin-observe", "observation_snapshot_id");
  const read = await c.call("eval", "protocol_read", { subject_version_id: subject });
  const protocol = str(read, "protocol_version_id", "protocol_read");
  const started = await c.call("eval", "evaluation_start", {
    subject_version_id: subject, protocol_version_id: protocol, observation_snapshot_id: snapshot,
    idempotency_key: c.key("start"), initiative: w.initiative,
  }, { note: (r) => `eval_run ${String(r.eval_run_id)}` });
  const evalRun = str(started, "eval_run_id", "evaluation_start");
  // Refs of every kind the protocol's measures judge, as the stage skill says, each found in this
  // stage: the approved specs of real use through the store's listing, the runs evaluation_start
  // returned, the team's knowledge nodes through search, and the bug reports through the queue.
  const listed = await c.call("core", "document_list", {});
  const specs = (String(listed.text ?? JSON.stringify(listed)).match(/\d{4}-\d{2}-\d{2}-[a-z0-9-]+-use-\d+\/spec\.md/g) ?? []).slice(0, 6);
  if (specs.length < 5) throw new Error(`document_list named ${specs.length} spec.md documents to judge: ${String(listed.text ?? "").slice(0, 400)}`);
  const rows = (r: Reply, key: string): Reply[] => (Array.isArray(r[key]) ? r[key] as Reply[] : []);
  // The runs that refused a call first: the refusal measures are asked about no other run.
  const runs = rows(started, "run_refs").sort((a, b) => Number(b.refused) - Number(a.refused))
    .map((r) => String(r.run_id)).slice(0, 6);
  const nodes = rows(await c.call("core", "knowledge_search", { query: "how a request is settled", limit: 20 }), "results")
    .filter((r) => r.initiative === "_knowledge").map((r) => `_knowledge/${String(r.path)}`).slice(0, 6);
  const bugs = rows(await c.call("core", "bug_list", { limit: 20 }), "bugs").map((b) => `bug:${String(b.id)}`).slice(0, 6);
  for (const [kind, found] of [["run", runs], ["knowledge", nodes], ["bug", bugs]] as const) {
    if (!found.length) throw new Error(`EVALUATE found no ${kind} ref to judge in the seeded use`);
  }
  const refs = [...specs, ...runs, ...nodes, ...bugs];
  await c.call("eval", "evaluation_assess", { eval_run_id: evalRun, subject_refs: refs, idempotency_key: c.key("assess") },
    { note: (r) => `${String(r.assessment_count)} assessments over ${refs.length} refs` });
  const score = await c.call("eval", "evaluation_score", { eval_run_id: evalRun, idempotency_key: c.key("score"), initiative: w.initiative },
    { note: (r) => `overall ${String(r.overall_score)} status ${String(r.score_status)} guardrails ${String(r.guardrail_status)} blocked by ${JSON.stringify(r.establishment_blocked_by)}` });
  if (score.record_refused) throw new Error(`evaluation_score did not record: ${String(score.record_refused)}`);
  // Seeded use carries every kind the reference protocol judges and its evaluators are qualified,
  // so anything short of established is a stage that did not work.
  if (score.score_status !== "established") {
    throw new Error(`evaluation_score is ${String(score.score_status)}, blocked by ${JSON.stringify(score.establishment_blocked_by)}`);
  }
  return { evalRun, score };
}

export async function explain(w: Walk): Promise<{ defect: string }> {
  const { c, status } = await enter(w, "zz-plugin-explain", { action: "write_document", document: "findings.md" });
  const evalRun = recorded(status, "zz-plugin-evaluate", "eval_run_id");
  const record = (finding: Record<string, unknown>) => c.call("eval", "finding_record",
    { eval_run_id: evalRun, finding, idempotency_key: c.key("finding"), initiative: w.initiative },
    { note: (r) => `finding ${JSON.stringify(r.finding).slice(0, 60)} ${String(finding.owner_kind)}` });
  await record({ kind: "strength", pattern: "Gated documents reach approval with their declared sections.",
    owner_kind: "plugin", measure_key: "document_gate_readiness" });
  const defect = await record({ kind: "defect", pattern: "A refusal does not steer the agent to the call that gets past it.",
    owner_kind: "plugin", measure_key: "refusal_recovery_path",
    expected_effect: { measure: "refusal_recovery_path", direction: "up",
      change: "zz-platform tells the agent to make the call a refusal names next, instead of retrying it" } });
  const stored = defect.finding && typeof defect.finding === "object" ? defect.finding as Reply : {};
  const id = String(stored.id ?? "");
  if (!id) throw new Error(`finding_record returned no id: ${JSON.stringify(defect).slice(0, 300)}`);
  return { defect: id };
}
