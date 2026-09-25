/**
 * Launching one replay exactly as the IMPROVE and PROMOTE/VERIFY skills say to: the run's token
 * (and a verifier token, for a proof run) written to mode-0600 files by a file write, never a
 * shell command, then `npm run replay -- --run … --repo … --token-file …` from the live checkout,
 * inside the launcher's real sandbox.
 *
 * The session binary is a stand-in `claude` on PATH, the same device the replay checks use
 * (checks/replay-hold-tree.ts): it answers the plugin install steps and prints one assistant turn.
 * The launcher still clones the subject at its release tag, checks the lock digest, applies a
 * candidate's patch, runs both sessions sandboxed, collects `produced`, closes the run and scores
 * it — everything but the model. The model credential is a dummy so the launcher's credential
 * refusal passes; the stand-in never calls a model.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { live, spawnAsync, type Stack } from "./stack.ts";
import { CANDIDATE_MARKER, RELEASED_MARKER } from "./stub-model.ts";

/** Writes the stand-in and returns the directory to put first on PATH. A turn reports whether the
 *  tree it ran in carries the candidate's change — the one thing a released subject's replay
 *  can show, since its patch is committed rather than applied. */
export function standIn(stack: Stack): string {
  const bin = join(stack.work, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), [
    "#!/bin/sh",
    'if [ "$1" = "plugin" ]; then exit 0; fi',
    `if grep -rqs ${CANDIDATE_MARKER} skills catalog 2>/dev/null; then seen=" ${RELEASED_MARKER}"; else seen=""; fi`,
    `echo "{\\"type\\":\\"assistant\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"Done.$seen\\"}]}}"`,
    `echo '{"type":"result","total_cost_usd":0}'`,
  ].join("\n") + "\n", { mode: 0o755 });
  return bin;
}

interface Launched { readonly status: string; readonly out: string }

/** `repo` must carry the subject's release tag: the seed for the release under evaluation, the
 *  release clone once a new release has been cut in it. */
export async function launch(stack: Stack, bin: string, run: { replay_run_id: string; token: string },
  verifierToken?: string, repo: string = stack.seed): Promise<Launched> {
  const d = mkdtempSync(join(tmpdir(), "zz-eval-flow-token-"));
  try {
    writeFileSync(join(d, "replay"), run.token, { mode: 0o600 });
    chmodSync(join(d, "replay"), 0o600);
    const args = ["run", "--silent", "replay", "--", "--run", run.replay_run_id, "--repo", repo,
      "--token-file", join(d, "replay")];
    if (verifierToken) {
      writeFileSync(join(d, "verifier"), verifierToken, { mode: 0o600 });
      chmodSync(join(d, "verifier"), 0o600);
      args.push("--verifier-token-file", join(d, "verifier"));
    }
    const { out } = await spawnAsync("npm", args, {
      cwd: live, timeoutMs: 600_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, ZZ_URL: stack.url, ZZ_TOKEN: stack.pat,
        ANTHROPIC_API_KEY: "sk-eval-flow-e2e-stand-in" },
    });
    const last = out.trim().split("\n").reverse().find((l) => l.startsWith("{")) ?? "";
    let status = "unknown";
    try {
      const parsed: unknown = JSON.parse(last);
      if (parsed && typeof parsed === "object" && "status" in parsed) status = String(parsed.status);
    } catch { /* status stays unknown; `out` says why */ }
    return { status, out };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
