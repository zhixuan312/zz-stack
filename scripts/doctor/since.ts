/**
 * Symptom to change: given a version that was known good, say which commits since it touched
 * the layer that disagrees.
 *
 * COUPLED: a layer declares the paths its claim is made of in `owns`, in run.ts, so the answer
 * is a path-filtered log and needs no judgement about what "related" means.
 *
 * It names suspects, not causes, and says so in the output. A layer's paths are where its
 * claim comes from, not the only place a change can break it: a gateway commit can break the
 * data layer through a query it did not touch.
 */
import { root, run } from "../deployment.ts";
import { layerOwns } from "./run.ts";

export function since(version: string, layers: string[]): string[] {
  const ref = /^v/.test(version) ? version : `v${version}`;
  let exists = false;
  try { exists = !!run("git", ["rev-parse", "--verify", "--quiet", `${ref}^{}`], { cwd: root }); } catch { /* reported below */ }
  if (!exists) return [`there is no ${ref} in this repository, so nothing can be correlated against it`];

  const out: string[] = [];
  for (const name of layers) {
    const owns = layerOwns(name);
    if (!owns.length) {
      out.push(`  ${name}: this layer declares no paths, so its changes cannot be listed — ` +
               `give it \`owns\` in its layer() call`);
      continue;
    }
    let log = "";
    try { log = run("git", ["log", "--oneline", `${ref}..HEAD`, "--", ...owns], { cwd: root }); }
    catch { out.push(`  ${name}: git could not read the range ${ref}..HEAD`); continue; }
    const commits = log.split("\n").filter(Boolean);
    out.push(commits.length
      ? `  ${name} — ${commits.length} commit(s) since ${ref} touched ${owns.join(", ")}:\n` +
        commits.map((c) => `      ${c}`).join("\n")
      : `  ${name} — nothing since ${ref} touched ${owns.join(", ")}, so the cause is somewhere else`);
  }
  return out;
}
