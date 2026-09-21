/**
 * The gate's own refusals, driven from outside and watched until they fail.
 *
 * WHY THESE ARE NOT CHECKS. Both refusals here are about the gate as a PROCESS — one refuses a
 * gate started inside a gate, the other a report path that resolves into the repository — and a
 * check that exercised either would have to launch a gate, which is the recursion the first one
 * exists to stop. `scripts/gate/run.ts` says so in as many words: it is exercised from outside.
 * This is outside.
 *
 * EVERY PROBE CARRIES ITS VALID PATH. A refusal that fires for everything is not a guard, it is
 * a broken gate, and the two are indistinguishable from the refusal alone. The control for both
 * is an ordinary run — no `ZZ_GATE_RUNNING`, a report path outside the tree — which must exit 0
 * and write its report; the mutation run's own baseline is that same control at full length.
 */
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

interface GuardProbe {
  readonly probe: string;
  readonly command: string;
  readonly expected: string;
  readonly observed: string;
  readonly exit: number;
  readonly held: boolean;
}

const gate = (repo: string, args: string[], env: Record<string, string>) =>
  spawnSync("node", ["scripts/gate.ts", ...args],
    { cwd: repo, encoding: "utf8", env: { ...process.env, ...env } });

/** What `marketplace/` and `.claude-plugin/` look like to git — empty means a refused gate
 *  regenerated nothing, which is the half of the recursion guard that actually protects work. */
const shelfDirty = (repo: string): string =>
  execFileSync("git", ["status", "--porcelain", "--", "marketplace", ".claude-plugin"],
    { cwd: repo, encoding: "utf8" }).trim();

export function probeGuards(repo: string, outsidePath: string): GuardProbe[] {
  const out: GuardProbe[] = [];

  const ok = gate(repo, ["--quiet", "--report", outsidePath], { ZZ_GATE_RUNNING: "" });
  out.push({
    probe: "the valid path — an ordinary run, no nested gate, a report path outside the tree",
    command: "node scripts/gate.ts --quiet --report <outside the repository>",
    expected: "exit 0 and a report written",
    observed: `exit ${ok.status}, report ${existsSync(outsidePath) ? "written" : "MISSING"}`,
    exit: ok.status ?? -1,
    held: ok.status === 0 && existsSync(outsidePath),
  });
  if (existsSync(outsidePath)) unlinkSync(outsidePath);

  const before = shelfDirty(repo);
  const nested = gate(repo, ["--quiet"], { ZZ_GATE_RUNNING: "1" });
  const after = shelfDirty(repo);
  const refused = /GATE REFUSED/.test(String(nested.stderr ?? ""));
  out.push({
    probe: "a gate started inside a gate is refused before anything is regenerated",
    command: "ZZ_GATE_RUNNING=1 node scripts/gate.ts --quiet",
    expected: "non-zero exit, GATE REFUSED on stderr, and the shelf untouched",
    observed: `exit ${nested.status}, ${refused ? "GATE REFUSED" : "no refusal on stderr"}, ` +
      `shelf ${after === before ? "untouched" : "CHANGED"}`,
    exit: nested.status ?? -1,
    held: nested.status !== 0 && refused && after === before,
  });

  const inside = gate(repo, ["--quiet", "--report", "mutation-guard-report.json"], { ZZ_GATE_RUNNING: "" });
  const said = /resolves inside the repository/.test(String(inside.stderr ?? ""));
  const landed = existsSync(join(repo, "mutation-guard-report.json"));
  out.push({
    probe: "a report path inside the repository is refused at import, before any check runs",
    command: "node scripts/gate.ts --quiet --report <a path inside the repository>",
    expected: "exit 2, a refusal naming the repository, and no file written",
    observed: `exit ${inside.status}, ${said ? "refusal names the repository" : "no such refusal"}, ` +
      `${landed ? "A FILE WAS WRITTEN" : "nothing written"}`,
    exit: inside.status ?? -1,
    held: inside.status === 2 && said && !landed,
  });

  return out;
}

/**
 * The guard this runner may not drive itself, driven by the plan owner and recorded verbatim.
 *
 * `report()` refuses an INCOMPLETE run — a module under `gate/checks/` that `gate.ts` never
 * imports keeps its `check(` lines where the count can find them and registers nothing. Making
 * it fail means removing an import from `scripts/gate.ts`, which this task's rules forbid this
 * runner's author from editing, in a copy as much as anywhere. So it was driven by the person
 * the rule does not bind, in a disposable copy, restored from a saved original rather than
 * from git, and the receipt is carried here with that attribution attached.
 *
 * IT IS RECORDED AS DRIVEN BECAUSE IT WAS. An artifact still saying nobody has watched a guard
 * fail, after somebody has, is a stale premise — the same defect this initiative spent the day
 * finding in checks that had stopped describing their own subjects.
 */
const EXTERNALLY_DRIVEN: GuardProbe & { readonly driven_by: string } = {
  probe: "GATE INCOMPLETE — a check module on disk that gate.ts never imports is caught",
  command: "in a disposable copy, remove one `import \"./gate/checks/<module>.ts\";` from " +
    "scripts/gate.ts, run the gate, then restore from a saved original",
  expected: "control PASSES; faulted run reports GATE INCOMPLETE and exits non-zero; " +
    "restored copy passes again and gate.ts is byte-identical to the original",
  observed: "control: GATE PASSED, 403 checks, exit 0. Faulted: GATE INCOMPLETE, 403 written " +
    "and 402 ran, exit 1, and a second check also caught it — scripts/gate.ts does not import " +
    "han-analysis.ts. Restored: GATE PASSED, 403 checks, exit 0, gate.ts byte-identical.",
  exit: 1,
  held: true,
  driven_by: "the plan owner, because the rule forbidding this file's author to edit " +
    "scripts/gate.ts does not bind them",
};

/**
 * The `guards` block for the report: what this run probed, what was driven externally, and
 * nothing carried forward that a later run has since answered.
 *
 * CALLED BY EVERY RUN, not only a `--guards` one. A top-up rebuilds the report object from
 * scratch, so a block it did not carry forward would silently vanish from the artifact — the
 * same shape as a `--only` run shortening the results it was supposed to add to.
 */
export function guardsBlock(existing: unknown, fresh: readonly GuardProbe[] | null): unknown {
  const prior = existing && typeof existing === "object" ? existing as Record<string, unknown> : {};
  const carried = Array.isArray(prior.probes) ? prior.probes as GuardProbe[] : [];
  const own = (fresh ?? carried).filter((g) => g.probe !== EXTERNALLY_DRIVEN.probe);
  return {
    probed_at: fresh ? new Date().toISOString() : prior.probed_at ?? null,
    probes: [...own, EXTERNALLY_DRIVEN],
  };
}
