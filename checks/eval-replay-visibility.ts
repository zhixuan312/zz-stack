#!/usr/bin/env node
// FR-25/26 and FR-60: each role sees exactly its visibility classes, in chronological order.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { visibleEvents } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/replay-cases.js")).href);
type Ev = { seq: number; visibility: string; kind: string };
const ev: Ev[] = [
  { seq: 3, visibility: "evaluation_oracle", kind: "approved_spec" },
  { seq: 0, visibility: "actor", kind: "brain_dump" },
  { seq: 2, visibility: "user_oracle", kind: "stakeholder_answer" },
  { seq: 1, visibility: "evaluation_oracle", kind: "audit_round" },
];
assert.deepEqual(visibleEvents(ev, "actor").map((e: Ev) => e.seq), [0], "actor sees only actor events");
assert.deepEqual(visibleEvents(ev, "simulated_person").map((e: Ev) => e.seq), [0, 2], "the simulated person never sees evaluation_oracle");
assert.deepEqual(visibleEvents(ev, "evaluator").map((e: Ev) => e.seq), [0, 1, 2, 3], "evaluators see everything, in order");
assert.throws(() => visibleEvents(ev, "search"), "an unknown role is refused, never defaulted");
console.log("ok eval-replay-visibility");
