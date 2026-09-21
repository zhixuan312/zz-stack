/**
 * What a planted defect is, how it is applied, and why the count of substitutions is the
 * measurement rather than a detail.
 *
 * A MUTATION THAT DID NOT LAND PROVES NOTHING. If the text a spec hunts for is not in the
 * file — it moved, it was reworded, the subject was rewritten — the replacement silently
 * does nothing, the gate passes, and the row reads exactly like a check that survived a real
 * defect. The two are indistinguishable from the outside, so the count is carried into the
 * report and a zero is a failed experiment to be fixed rather than a result to be recorded.
 *
 * THE DEFECT GOES IN THE SUBJECT, NEVER IN THE CHECK. A check that only passes because the
 * thing it examines still READS correctly is the failure mode this whole run exists to find,
 * so every spec here names a file the check reads and changes what that file DOES. Comments
 * and the check's own name are left alone by construction: nothing here can write to
 * `scripts/gate/checks/` or to `scripts/gate.ts`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MutationSpec {
  /** The declared check file this row is about, repo-relative. */
  readonly check: string;
  /** The registered check inside that file the defect is aimed at, by its exact name. */
  readonly target: string;
  /** The file the defect is planted in — what `target` examines, never `check` itself. */
  readonly subject: string;
  /** The exact text to replace. Long enough to be unique unless `all` says otherwise. */
  readonly find: string;
  /** What replaces it. Behaviour changes here; prose does not. */
  readonly replace: string;
  /** Replace every occurrence rather than requiring exactly one. */
  readonly all?: boolean;
  /**
   * Which of the check's independent assertions this row establishes, where it has more than
   * one. A registered check may make several claims that fail for different reasons, and a
   * mutation to one says nothing about the others — so two rows can share a `target` and be
   * about different things, and this is what tells them apart.
   */
  readonly assertion?: string;
  /** The defect, in the words a reader of the report needs. */
  readonly planted: string;
  /** Set when this row is known not to prove what it looks like it proves, and why. */
  readonly caveat?: string;
  /**
   * Keep this mutation's text out of the report in plain form.
   *
   * THE REPORT IS A TRACKED FILE AND THE REPOSITORY SWEEPS ITSELF. One check here refuses any
   * tracked file that carries a routable address, an email or a credential shape — so the only
   * defect that can prove that check works is one whose payload, written verbatim into the
   * report, makes the repository fail its own sweep. It did: the artifact turned the gate red
   * on its next run. Redacted rows carry the same text base64-encoded, so the experiment is
   * still exactly reproducible and the report is not itself the disclosure.
   */
  readonly redact?: boolean;
}

/** A subject this runner refuses to touch, whatever a spec says. The checks and the order
 *  they run in are the things under test; a run that edited them would be measuring itself. */
const FROZEN = ["scripts/gate/checks/", "scripts/gate.ts", "scripts/gate/"];

interface Planted {
  readonly replacements: number;
  readonly before: string;
}

/** Apply one spec to the workspace and say how many substitutions actually happened. */
export function plant(repo: string, spec: MutationSpec): Planted {
  for (const frozen of FROZEN) {
    if (spec.subject.startsWith(frozen)) {
      throw new Error(`${spec.check}: refusing to mutate ${spec.subject} — the checks and the ` +
        "order they run in are what this run measures, not what it may edit");
    }
  }
  const path = join(repo, spec.subject);
  const before = readFileSync(path, "utf8");
  let replacements = 0;
  let after: string;
  if (spec.all) {
    after = before.split(spec.find).join(spec.replace);
    replacements = before.split(spec.find).length - 1;
  } else {
    const at = before.indexOf(spec.find);
    if (at < 0) {
      after = before;
    } else {
      if (before.indexOf(spec.find, at + spec.find.length) >= 0) {
        throw new Error(`${spec.check}: "${spec.find.slice(0, 40)}…" occurs more than once in ` +
          `${spec.subject}; a spec that cannot say WHICH occurrence it means is not a measurement`);
      }
      after = before.slice(0, at) + spec.replace + before.slice(at + spec.find.length);
      replacements = 1;
    }
  }
  if (replacements > 0) writeFileSync(path, after);
  return { replacements, before };
}
