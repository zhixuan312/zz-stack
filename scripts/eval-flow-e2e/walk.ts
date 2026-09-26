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
  return Array.isArray(d.candidates) ? d.candidates.length : 0;
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
  await c.call("core", "document_write", { path, content: [
    "## The plugin under evaluation",
    `${w.plugin} ${String(located.declared_version)}, content digest ${String(located.content_digest)}; ` +
      `protocol version 1, content_digest ${digest}.`,
    "", "## What good means here",
    ...dims.map((d) => `- **${d.key}** (weight ${d.weight}): ${d.measures.map((m) => m.key).join(", ")}.`),
    "", "## The evidence each dimension reads",
    ...dims.flatMap((d) => d.measures.map((m) => `- ${m.key}: ${MODEL_BACKED.has(m.evaluatorType)
      ? "a qualified typed evaluator reading the artifact's text" : "a fact OBSERVE computed"}.`)),
    "",
  ].join("\n") });
  await c.call("core", "document_present", { path });
  await c.call("core", "document_approve", { path });
  await c.call("eval", "protocol_affirm", { protocol_version_id: protocol, initiative: w.initiative, idempotency_key: c.key("affirm") });
  const qualified: Record<string, string> = {};
  for (const m of dims.flatMap((d) => d.measures).filter((m) => MODEL_BACKED.has(m.evaluatorType))) {
    const q = await c.call("eval", "evaluator_qualify", { protocol_version_id: protocol, measure_key: m.key, idempotency_key: c.key(`qualify-${m.key}`) },
      { note: (r) => `${m.key}: ${String(r.state)}` });
    qualified[m.key] = String(q.state);
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
    idempotency_key: c.key("start"),
  }, { note: (r) => `eval_run ${String(r.eval_run_id)}` });
  const evalRun = str(started, "eval_run_id", "evaluation_start");
  // The documents the tools under evaluation produced: the approved documents of the closed
  // initiatives of real use, found through the store's own listing.
  const listed = await c.call("core", "document_list", {});
  const refs = (String(listed.text ?? JSON.stringify(listed)).match(/\d{4}-\d{2}-\d{2}-[a-z0-9-]+-use-\d+\/spec\.md/g) ?? []).slice(0, 6);
  if (refs.length < 5) throw new Error(`document_list named ${refs.length} spec.md documents to judge: ${String(listed.text ?? "").slice(0, 400)}`);
  await c.call("eval", "evaluation_assess", { eval_run_id: evalRun, subject_refs: refs, idempotency_key: c.key("assess") },
    { note: (r) => `${String(r.assessment_count)} assessments over ${refs.length} refs` });
  const score = await c.call("eval", "evaluation_score", { eval_run_id: evalRun, idempotency_key: c.key("score"), initiative: w.initiative },
    { note: (r) => `overall ${String(r.overall_score)} status ${String(r.score_status)} guardrails ${String(r.guardrail_status)}` });
  if (score.record_refused) throw new Error(`evaluation_score did not record: ${String(score.record_refused)}`);
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
