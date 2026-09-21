import { serializeReceipt } from "@zz/indexing";
import { check } from "../run.ts";

check("the retrieval serializer reports unknowns as unknown and never guesses a type from a filename", () => {
  const r = serializeReceipt({ rows: [{ path: "2026-09-20-x/spec.md", envelope_type: "agreement" }], raw: { ref: "r1" } });
  const item = r.items[0];
  if (item.content_type !== "agreement") return `content_type came back as ${String(item.content_type)}; the envelope says agreement and the filename says spec`;
  const blank = serializeReceipt({ rows: [{ path: "a/b.md" }], raw: { ref: "r2" } }).items[0];
  if (blank.content_type !== null) return "an absent content_type was defaulted instead of left null";
  if (blank.status_origin !== "unknown") return "an absent fact did not record status_origin: unknown";
  if (blank.gate_status !== null) return "an absent gate_status was defaulted";
  if (!r.raw_response_ref) return "the raw response was not preserved as a protected reference";
  const cp = serializeReceipt({ rows: [{ path: "a/b.md", assurance: "current_path" }], raw: { ref: "r3" } }).items[0];
  if (cp.canAuthorizeMutation) return "a current_path lead claims it can authorize a protected mutation";
});
