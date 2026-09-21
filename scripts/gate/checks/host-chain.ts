import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { root } from "../read.ts";
import { check } from "../run.ts";

function execStderr(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  return String(e.stderr ?? e.message ?? err);
}

check("a registered procedure's chain is enforced all the way back, and still grants when it is met", () => {
  // THE CHAIN WAS DECORATIVE AND TWO FIXTURES AGREED IT WAS NOT. `evaluate` asked whether the
  // step immediately before had met its OWN completion rules, which says nothing about the
  // steps before that — so a seven-step procedure was checked one link deep, and a step whose
  // completion rules are empty was vacuously met and became a permanent hole every later step
  // was measured through. The registered body granted its closing action on a run holding
  // nothing but the closing document.
  //
  // IT SURVIVED BECAUSE NO SUBJECT COULD EXPRESS IT. The second-flow fixture is two steps, so
  // there is no "three steps back" for it to get wrong; the negative control gives every step
  // a sign-off rule, so it has no rule-free step in the middle. Both agreed with the engine
  // and neither could disagree. This check's subject is what the release actually registers,
  // which is why it can.
  //
  // BOTH HALVES, and the second is not a formality. A host that refused everything would pass
  // a check that only watched the refusal — and would be a worse host than the broken one,
  // because a control loop that never grants is a control loop nobody can finish. So the same
  // procedure is driven to a genuinely complete run and the same action must be granted.
  //
  // DERIVED FROM THE MODULE, never written out here. The evidence is generated from each
  // step's own completion rules — the counts it asks for, and the back-reference an `about`
  // rule demands — so this check has no flow's vocabulary in it and a second registered module
  // is covered the day it is approved.
  const dist = join(root, "services/zz-core/dist");
  if (!existsSync(join(dist, "reviewed-modules.js"))) {
    return "services/zz-core is not built, so the registered procedures cannot be driven — run `npx tsc -b` before the gate";
  }
  const probe = `
    import { reviewedModuleHost } from ${JSON.stringify(join(dist, "host/index.js"))};
    import { packagedModules } from ${JSON.stringify(join(dist, "reviewed-modules.js"))};
    const bad = [];
    const SUBJECT = "a run this check opened";

    // A CATALOGUE THAT WILL NOT REGISTER IS SOMEBODY ELSE'S FAULT, and saying so beats dying
    // on it: registration throws by design, and an uncaught call here would report a stack
    // tail for a defect the catalogue check already names in a sentence.
    try { reviewedModuleHost(packagedModules); }
    catch (err) {
      process.stdout.write(JSON.stringify([
        "this release's catalogue does not register, so no procedure could be driven: " +
        (err && err.message ? err.message : String(err))]));
      process.exit(0);
    }

    for (const module of packagedModules.bodies.values()) {
      const last = module.steps[module.steps.length - 1];
      // A PROCEDURE WITH NOTHING BEHIND ITS LAST STEP HAS NO CHAIN TO ENFORCE. Reporting that
      // as a pass would be reporting it as covered; it is not a subject, and it is skipped by
      // name so the count below can tell "no chain" from "no modules".
      if (module.steps.length < 2 || !last.after.length || !last.grants.length) continue;
      const action = last.grants[0];
      const earlier = module.steps.slice(0, -1).map((s) => s.id);

      // HALF ONE: nothing recorded, so every step behind the last is outstanding.
      const empty = reviewedModuleHost(packagedModules);
      const emptyRun = empty.host.runStart(module.id, { subject: SUBJECT, profile: module.enrolment.requires });
      const onEmpty = empty.host.actionClaim(emptyRun, last.id, action);
      if (onEmpty.granted) {
        bad.push(module.id + ": " + action + " was granted on a run holding no evidence at all, so " +
                 "the steps the procedure declares before " + last.id + " are decoration");
      } else if (!earlier.some((id) => onEmpty.refusal.includes(id))) {
        // THE REFUSAL MUST BE ABOUT THE CHAIN. A host that refused only on the last step's own
        // rules would refuse here too, and pass a check that read nothing but \`granted\`.
        bad.push(module.id + ": " + action + " was refused on an empty run without naming any " +
                 "earlier step — the refusal reads \\"" + onEmpty.refusal + "\\", which is the last " +
                 "step judged alone rather than the chain being enforced");
      }

      // HALF TWO: every step satisfied on its own terms, in order, from its own rules.
      const full = reviewedModuleHost(packagedModules);
      const run = full.host.runStart(module.id, { subject: SUBJECT, profile: module.enrolment.requires });
      const recorded = [];
      let broke = null;
      for (const step of module.steps) {
        for (const rule of step.completion) {
          if (!step.accepts.some((k) => k.name === rule.kind)) {
            broke = step.id + " must be completed with " + rule.kind + ", which it does not accept";
            break;
          }
          for (let n = 0; n < rule.atLeast; n += 1) {
            const target = rule.about === undefined
              ? SUBJECT
              : recorded.filter((e) => e.kind === rule.about).map((e) => e.id).pop();
            if (target === undefined) {
              broke = step.id + " needs a " + rule.kind + " about a " + rule.about +
                      ", and no step before it records one";
              break;
            }
            const entry = { id: module.id + "/" + step.id + "/" + rule.kind + "/" + n,
                            kind: rule.kind, about: target, note: "recorded by the gate" };
            full.host.evidenceRecord(run, step.id, entry);
            recorded.push(entry);
          }
          if (broke) break;
        }
        if (broke) break;
      }
      if (broke) { bad.push(module.id + ": this check could not complete the procedure from its own rules — " + broke); continue; }

      const onFull = full.host.actionClaim(run, last.id, action);
      if (!onFull.granted) {
        bad.push(module.id + ": " + action + " was refused on a run where every step's own " +
                 "completion rules are met — \\"" + onFull.refusal + "\\". A chain that cannot be " +
                 "satisfied is not a control, it is a wall");
      }
      // And the whole procedure must read as done, not merely the step that was claimed.
      const standing = full.evaluate(module, run);
      const open = standing.filter((s) => !s.satisfied).map((s) => s.stepId);
      if (open.length) {
        bad.push(module.id + ": the run that granted " + action + " still reports [" + open.join(", ") +
                 "] outstanding, so the grant and the evaluation disagree about the same run");
      }
    }
    process.stdout.write(JSON.stringify(bad));
  `;
  try {
    const bad: string[] = JSON.parse(
      execFileSync("node", ["--input-type=module", "-e", probe], { encoding: "utf8" }));
    return bad.length ? bad.join("; ") : null;
  } catch (err) {
    return `the registered procedures could not be driven: ${execStderr(err).slice(-300)}`;
  }
});
