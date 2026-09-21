import { snapshot, stillValid, boundaryOf } from "@zz/contracts";
import { check } from "../run.ts";

check("a grant invalidates when a dependency moves even though the target bytes do not", () => {
  const base = { etag: "e1", content_hash: "h1", sources: ["s1"], manifest: "m1",
                 qualification: "q1", permission_epoch: "p1", profile: "pr1" };
  const snap = snapshot(base);
  for (const field of ["sources", "manifest", "qualification", "permission_epoch", "profile"]) {
    const moved = { ...base, [field]: field === "sources" ? ["s1", "s2"] : `${base[field as keyof typeof base]}-x` };
    if (stillValid(snap, moved)) {
      return `${field} changed while etag and content_hash stayed h1/e1, and the grant was still considered valid — `
           + `a record-local digest cannot see this, which is exactly the withdrawn assumption`;
    }
  }
  if (!stillValid(snap, base)) return "an unchanged dependency set was reported invalid";

  const b = boundaryOf("action_complete");
  if (!b.serialized) return "the predicate check and the effect publication do not share a serialization boundary";
  if (!b.covers.includes("permission_store")) return "the boundary does not cover the separate permission store, so a stale grant can race a revocation";
  if (b.holdsLockAcrossModelCall) return "a model call is made while holding the document lock";
});
