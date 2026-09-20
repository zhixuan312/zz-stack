import assert from 'node:assert/strict';
import { evaluateTargets } from '../scripts/tenant-info/benchmark.ts';
const good={recall_at_5:0.80,recall_at_20:0.95,mrr_at_10:0.80,
  exact_id_resolution:1,identifier_part_recall_at_5:0.95,typo_recall_at_20:0.90,
  no_answer_correct_rate:0.90,latency_p95_ms:750,latency_p99_ms:2000,
  rebuild_minutes:120,projection_freshness_p99_ms:5000,
  en_recall_at_20:0.95,zh_recall_at_20:0.95,mixed_recall_at_20:0.95,
  unauthorized_results:0,lost_acknowledged_writes:0,silent_truncations:0,semantic_parity:1};
assert.equal(evaluateTargets(good).passed,true);
const minimums=['recall_at_5','recall_at_20','mrr_at_10','exact_id_resolution',
  'identifier_part_recall_at_5','typo_recall_at_20','no_answer_correct_rate',
  'en_recall_at_20','zh_recall_at_20','mixed_recall_at_20','semantic_parity'];
for (const key of minimums) assert.equal(evaluateTargets({...good,[key]:0}).passed,false);
for (const key of ['latency_p95_ms','latency_p99_ms','rebuild_minutes','projection_freshness_p99_ms']) {
  assert.equal(evaluateTargets({...good,[key]:1e9}).passed,false);
}
for (const key of ['unauthorized_results','lost_acknowledged_writes','silent_truncations']) {
  assert.equal(evaluateTargets({...good,[key]:1}).passed,false);
}
for (const key of Object.keys(good)) {
  const missing: Record<string,number>={...good}; delete missing[key];
  const result=evaluateTargets(missing);
  assert.equal(result.passed,false); assert.ok(result.blocked.includes(key));
}
assert.equal(evaluateTargets({...good,latency_p95_ms:NaN}).passed,false);
console.log('benchmark-report-completeness: ok');
