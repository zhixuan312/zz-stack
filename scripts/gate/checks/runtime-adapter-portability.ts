import { adapters, runConformance } from "@zz/contracts";
import { check } from "../run.ts";

const OPS = ["capabilities", "load_method", "dispatch", "observe", "cancel", "resume"];

check("a second runtime adapter runs the same protocol with a different event format", () => {
  const names = adapters.runtime.map((a) => a.id);
  if (names.length < 2) return `only ${names.length} runtime adapter(s) exist; portability is asserted, not demonstrated`;
  const other = adapters.runtime.find((a) => a.id !== "claude-code");
  if (!other) return "no non-Claude runtime adapter exists";

  for (const a of adapters.runtime) {
    for (const op of OPS) if (typeof a[op] !== "function") return `${a.id} does not implement ${op}`;
    const d = a.dispatch({ claim: "c1", contract: {} });
    if (d.completed !== undefined) return `${a.id}.dispatch reported completion; dispatch returns a work id`;
    if (!d.work_id) return `${a.id}.dispatch returned no work id`;
    const c = a.cancel({ work_id: d.work_id });
    if (!["requested", "confirmed_stopped", "unsupported"].includes(c.state)) return `${a.id}.cancel returned ${c.state}`;
    if (c.state === "requested" && c.treatedAsStopped) return `${a.id} treated a cancellation request as confirmation`;
  }
  if (other.eventFormat === adapters.runtime.find((a) => a.id === "claude-code")?.eventFormat) {
    return "the second adapter reuses the Claude transcript format, so it does not demonstrate portability";
  }
  const r = runConformance(other);
  if (!r.passed) return `the non-Claude adapter failed the shared conformance protocol: ${r.reason}`;
  if (r.usedClaudeToolNames.length) return `shared code reached Claude-specific names: ${r.usedClaudeToolNames.join(", ")}`;
});
