/**
 * What a machine without Docker still has to be told: that the work this release would have done
 * locally has been done, and by whom.
 *
 * `scripts/release.ts` runs the gate and builds both images itself, which makes Docker a
 * prerequisite for releasing from anywhere. Both can run on a GitHub runner instead
 * (`.github/workflows/gate.yml` and `images.yml`), and the two flags that skip them here —
 * `--gate-in-ci` and `--images-from-ci` — are worth nothing unless the run really passed on THIS
 * commit.
 *
 * DELIBERATE: neither flag is a promise. This asks GitHub for the run's own conclusion, and a
 * missing run, a run that failed and a run still in flight are three different refusals with the
 * run's URL in the sentence — so "CI did it" is evidence a reader can open, not an attestation
 * somebody typed.
 */
import { run } from "../deployment.ts";

interface RunRow { conclusion: string | null; status: string; url: string; headSha: string }

interface CiRun { conclusion: string; url: string; sha: string; workflow: string }

/** The rows `gh run list --json …` printed, narrowed field by field.
 *
 * DELIBERATE: not a cast. `gh` is another program, its output is input, and a run that answered in
 * a shape this does not expect has to read as "no run" rather than as a run whose fields are
 * whatever the cast claimed.
 */
function rowsFrom(json: string): RunRow[] {
  const parsed: unknown = JSON.parse(json || "[]");
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((row): RunRow[] => {
    if (typeof row !== "object" || row === null) return [];
    const o = row as Record<string, unknown>;
    if (typeof o.url !== "string" || typeof o.headSha !== "string") return [];
    return [{
      url: o.url, headSha: o.headSha,
      conclusion: typeof o.conclusion === "string" ? o.conclusion : null,
      status: typeof o.status === "string" ? o.status : "",
    }];
  });
}

/** The newest run of `workflow` for `sha`, or null when GitHub lists none for it. */
function latestCiRun(workflow: string, sha: string): CiRun | null {
  let out: string;
  try {
    out = run("gh", ["run", "list", "--workflow", workflow, "--commit", sha, "--limit", "1",
                     "--json", "conclusion,status,url,headSha"]);
  } catch (err) {
    throw new Error(`could not ask GitHub about ${workflow} on ${sha.slice(0, 8)}: ` +
      `${err instanceof Error ? err.message : String(err)} — gh has to be installed and signed in.`);
  }
  const r = rowsFrom(out)[0];
  // The headSha is compared rather than trusted: `--commit` filters, and a GitHub that ignored it
  // would hand back somebody else's green run.
  return r && r.headSha === sha
    ? { conclusion: r.conclusion ?? r.status, url: r.url, sha, workflow }
    : null;
}

/** The run, or a refusal naming which of the three reasons it is. */
export function requireCiGreen(workflow: string, sha: string, what: string): CiRun {
  const r = latestCiRun(workflow, sha);
  if (!r) {
    throw new Error(`no ${workflow} run for ${sha.slice(0, 8)} — ${what}. Open the Actions tab, ` +
      `run it on this commit (workflow_dispatch) and wait for it to pass.`);
  }
  if (r.conclusion !== "success") {
    throw new Error(`${workflow} did not pass on ${sha.slice(0, 8)} (${r.conclusion}) — ${what}. ` +
      `See ${r.url}`);
  }
  return r;
}
