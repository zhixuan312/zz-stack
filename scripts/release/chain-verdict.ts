/**
 * What the live chain check's run means, decided from its inputs and its output alone — no
 * deployment, no environment — so checks/release-probe-token.ts drives every branch. chain-live.ts
 * runs the walk and asks these.
 */
export type Verdict = { verdict: "wrong" | "unknown"; detail: string } | null;

/** A chain-check line that says a superadmin-only probe did not run. COUPLED: chain-check.ts and
 *  chain-bugs.ts print `  skip  … behind \`if (sup)\` …` for exactly those. */
const SUPERADMIN_SKIP = /^\s*skip\s+(.*`if \(sup\)`.*)$/;

/** The superadmin probes a finished run skipped, one line each. */
export function skippedSuperadmin(out: string): string[] {
  return out.split("\n").map((l) => SUPERADMIN_SKIP.exec(l)?.[1]?.trim()).filter((l): l is string => !!l);
}

/** Which token walks the chain, or what stops the walk before it starts. Pure over its inputs so
 *  a check can drive every branch without a deployment.
 *
 *  ZZ_PROBE_TOKEN when it is set. Absent, the chain is still walked with ZZ_TOKEN — every probe an
 *  admin is offered still runs — and `probe: false` makes chainOutcome report the superadmin ones
 *  as unknown rather than letting their skip pass. */
export function chainToken(gateway: string, envTok: string, probeTok: string):
    { token: string; probe: boolean } | NonNullable<Verdict> {
  if (!gateway) return { verdict: "unknown", detail: "chain-check: no ZZ_PUBLIC_URL to walk the chain against" };
  if (probeTok && !/^zzp_\S+$/.test(probeTok)) {
    return { verdict: "unknown", detail: `chain-check: ZZ_PROBE_TOKEN is not shaped like a token (${probeTok.length} characters)` };
  }
  if (probeTok) return { token: probeTok, probe: true };
  if (!envTok) return { verdict: "unknown", detail: "chain-check: no ZZ_PROBE_TOKEN and no ZZ_TOKEN to walk the chain with" };
  return { token: envTok, probe: false };
}

/** The verdict on a run that exited 0: clean, or `unknown` naming the superadmin probes it
 *  skipped and why — no probe token, or a probe token that is not a superadmin's. */
export function chainOutcome(out: string, probe: boolean): Verdict {
  const skipped = skippedSuperadmin(out);
  if (!skipped.length) return null;
  return { verdict: "unknown",
    detail: (probe
      ? `chain-check skipped ${skipped.length} superadmin probe(s) — ZZ_PROBE_TOKEN is not a superadmin's`
      : `chain-check: no probe token — ${skipped.length} superadmin probe(s) did not run. Set ` +
        "ZZ_PROBE_TOKEN in this repository's .env to a superadmin's PAT") +
      `: ${skipped.join(" | ")}` };
}
