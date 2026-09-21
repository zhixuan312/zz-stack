import { reconcile } from "@zz/contracts";
import { check } from "../run.ts";

check("a canonical no-op is durable, and an unknown commit reconciles instead of replaying", () => {
  const noop = reconcile({ committed: true, changed: false, transaction_id: null, artifact_id: "a1",
                           revision: null, content_hash: "h1", etag: "e1", commit_sequence: null,
                           projection: "current", history_export: "current" });
  if (noop.state !== "applied") return `a canonical no-op reconciled to ${noop.state}, not applied`;
  if (noop.invented) return "the no-op path invented a transaction id, revision or commit sequence";
  if (noop.replay) return "a canonical no-op was scheduled for replay";

  const lagging = reconcile({ committed: true, changed: true, transaction_id: "t1", artifact_id: "a1",
                              revision: 2, content_hash: "h2", etag: "e2", commit_sequence: 9,
                              projection: "pending", history_export: "pending" });
  if (lagging.state !== "applied") return "a committed write with a lagging projection was not recorded durable";
  if (lagging.replay) return "projection lag caused the business effect to be replayed";

  const refused = reconcile({ committed: false, code: "STALE_ETAG", message: "x" });
  if (refused.state !== "failed") return "a definite refusal was not treated as definite";
  if (refused.substitutedEtag) return "the newest etag was silently substituted into the old request";

  const unknown = reconcile({ committed: "unknown", code: "COMMIT_STATUS_UNKNOWN", transaction_id: "t2",
                             idempotency_key: "k2", message: "x" });
  if (unknown.state !== "reconciling") return `an unknown commit reconciled to ${unknown.state}`;
  if (unknown.newIdempotencyKey) return "an unknown commit was redispatched under a new idempotency key";
});
