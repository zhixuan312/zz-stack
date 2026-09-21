import { jevAdapter } from "@zz/contracts";
import { check } from "../run.ts";

check("the first provider adapter validates identity, ranges and retry classification", () => {
  const ok = jevAdapter.parse({ model: "jev-1.2.3", choice: "supports" }, { expect: "jev-1.2.3" });
  if (ok.status !== "answered") return `a valid response parsed to ${ok.status}`;
  if (ok.identity_assurance !== "provider_reported") return "a hosted version assertion was recorded as stronger than provider_reported";
  if (!ok.raw_response_ref) return "the raw provider response was not preserved";

  const drift = jevAdapter.parse({ model: "jev-1.2.4", choice: "supports" }, { expect: "jev-1.2.3" });
  if (drift.status !== "invalid_response") return "an exact-version mismatch was accepted";

  const bad = jevAdapter.parse({ model: "jev-1.2.3", score: undefined }, { expect: "jev-1.2.3" });
  if (bad.value !== null) return "an undefined score coerced to a value instead of failing";
  const oor = jevAdapter.parse({ model: "jev-1.2.3", score: 7 }, { expect: "jev-1.2.3", legend: [0, 1] });
  if (oor.status !== "invalid_response") return "an out-of-range score was accepted";

  for (const [code, want] of [[429, true], [529, true], [500, true], [401, false], [422, false]] as const) {
    if (jevAdapter.retryable(code) !== want) return `status ${code} retry classification is wrong`;
  }
  if (!jevAdapter.honoursRetryAfter) return "the retry policy ignores Retry-After";
});
