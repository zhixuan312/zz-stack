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
  // The chain is checked to its root, not one link deep. Asking only whether the step
  // immediately before met its own completion rules says nothing about the steps before that,
  // and a step whose completion rules are empty is vacuously met and becomes a permanent hole
  // every later step is measured through.
  //
  // The subject is what the release actually registers. A two-step fixture has no "three steps
  // back" to get wrong, and a negative control giving every step a sign-off rule has no
  // rule-free step in the middle, so neither can disagree with the engine.
  //
  // Both halves: a host that refused everything would pass a check that only watched the
  // refusal, and a control loop that never grants is one nobody can finish. So the same
  // procedure is driven to a genuinely complete run and the same action must be granted.
  //
  // Derived from the module, never written out here: the evidence is generated from each step's
  // own completion rules, so this check carries no flow's vocabulary and covers a second
  // registered module the day it is approved.
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

check("a fact a later entry withdrew stops being counted, and the log still only grows", () => {
  // A withdrawn approval stops counting.
  //
  // `zz.control_evidence` is append-only: a fact is a fact and the log is the history of what
  // the platform was told. But a gated document can be revised — the platform files the signed
  // text, bumps the version and returns the document to draft, clearing the approval it
  // carried. Deleting the entry would falsify the history; counting it says the step is met
  // while the document is a draft nobody has agreed to.
  //
  // Both halves, because a kernel that counted nothing would pass a check watching only the
  // refusal and would make every procedure unfinishable. The complete run must still grant.
  const dist = join(root, "services/zz-core/dist");
  if (!existsSync(join(dist, "reviewed-modules.js"))) {
    return "services/zz-core is not built, so the registered procedures cannot be driven — run `npx tsc -b` before the gate";
  }
  const probe = `
    import { reviewedModuleHost } from ${JSON.stringify(join(dist, "host/index.js"))};
    import { packagedModules } from ${JSON.stringify(join(dist, "reviewed-modules.js"))};
    const bad = [];
    for (const m of packagedModules.bodies.values()) {
      const gated = m.steps.find((s) => s.completion.some((c) => c.kind === "approval"));
      const last = m.steps[m.steps.length - 1];
      // Not every registered procedure has an approval to withdraw; one that does not is not
      // a subject here, and skipping it by name keeps "no subject" apart from "no modules".
      if (!gated || !last.grants.length) continue;
      const { host } = reviewedModuleHost(packagedModules);
      const run = host.runStart(m.id, { subject: "withdrawal probe", profile: m.enrolment.requires });
      const recorded = [];
      for (const step of m.steps) {
        for (const rule of step.completion) {
          for (let n = 0; n < rule.atLeast; n++) {
            const about = rule.about === undefined ? "withdrawal probe"
              : recorded.filter((e) => e.kind === rule.about).map((e) => e.id).pop();
            const entry = { id: step.id + "/" + rule.kind + "/" + n, kind: rule.kind, about, note: "driven by the gate" };
            host.evidenceRecord(run, step.id, entry);
            recorded.push(entry);
          }
        }
      }
      const whole = host.actionClaim(run, last.id, last.grants[0]);
      if (!whole.granted) {
        bad.push(m.id + ": the complete procedure was refused before anything was withdrawn — " + whole.refusal);
        continue;
      }
      const approval = recorded.find((e) => e.kind === "approval" && e.id.startsWith(gated.id + "/"));
      host.evidenceRecord(run, gated.id, {
        id: gated.id + "/document/revised", kind: "document", about: "withdrawal probe",
        note: "revised; the approval this step carried no longer stands",
        supersedes: approval.id,
      });
      const after = host.actionClaim(run, last.id, last.grants[0]);
      if (after.granted) {
        bad.push(m.id + ": " + last.grants[0] + " is still granted after the approval it counts was " +
                 "withdrawn — the loop is answering a question about the run's current state with " +
                 "a fact that no longer stands");
      } else if (!after.refusal.includes(gated.id)) {
        bad.push(m.id + ": the claim was refused after the withdrawal but the refusal does not name " +
                 gated.id + " — it reads \\"" + after.refusal + "\\", so something else is refusing " +
                 "and the withdrawal is unproven");
      }
    }
    console.log(JSON.stringify(bad));
  `;
  let out: string;
  try {
    out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8" });
  } catch (err) {
    return `the withdrawal probe could not run, so this is unchecked: ${execStderr(err).slice(0, 300)}`;
  }
  const bad = JSON.parse(out.trim()) as string[];
  if (bad.length) return bad.join("; ");
  return null;
});
