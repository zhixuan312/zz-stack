/**
 * manifest-audit — the platform's mechanical outcome audit (generic).
 *
 * Reads the flow's manifest (flow.json) and audits a team store against the discipline the flow
 * itself declares; the platform never hardcodes any flow's chain. Pure code; PASS means the
 * artifacts mechanically prove the flow ran right, FAIL names the defect.
 *
 *   npm run audit -- --manifest catalog/<owner>/<flow>/flow.json \
 *                    --store /var/lib/docker/volumes/zz_zz-artifacts/_data/teams/<team>
 *                    [--require-closed]   # an initiative still open is a FAIL, for CI
 *
 * COUPLED: the envelope parser is imported from @zz/contracts, never reimplemented here. An audit
 * that reads an envelope differently from the platform that wrote it reports defects the platform
 * does not have and misses the ones it does.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { manifestAt } from "@zz/catalog";
import { OUTCOMES, OUTCOME_STOPPED, STATUSES, parseEnvelope } from "@zz/contracts";

import { die, parseArgs, required } from "../lib/cli.js";

interface DocSpec {
  name: string;
  gate?: boolean;
  closing?: boolean;
  requiredForClose?: boolean;
}

/** The envelope of a file, or an empty one when it is absent or unreadable. */
function frontmatter(path: string): Record<string, string> {
  try {
    return parseEnvelope(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * (defects, closed). Whether it closed is reported separately from whether what exists is
 * well-formed, because almost every check below applies only to a closed initiative — so an
 * unfinished one skips them and looks identical to a clean pass.
 */
function auditInitiative(
  folder: string,
  docs: DocSpec[],
  closing: string,
  team = "",
): { problems: string[]; closed: boolean } {
  const problems: string[] = [];
  const closingPath = join(folder, closing);
  const closingFm = existsSync(closingPath) ? frontmatter(closingPath) : {};
  const outcome = closingFm.outcome ?? "";
  const closed = Boolean(outcome);

  // `outcome` is a claim about what a person said, so this reads who said it rather than only
  // whether the word is there. Every outcome is somebody's verdict, not only `accepted`:
  // `delivered` is the same finished initiative with the same ledger row, and `abandoned` is a
  // decision too — "who decided to stop" is what a ledger row gets read to answer later.
  if (outcome) {
    // The word itself. Every rule below is written against a known outcome, so a word that is not
    // one of them falls through all of them and the initiative is reported PASS — while this
    // audit exists to catch a store edited outside the platform, which is the only way an unknown
    // outcome gets there.
    if (!(OUTCOMES as readonly string[]).includes(outcome)) {
      problems.push(`${closing} carries outcome: '${outcome}', which is not an outcome this ` +
                    `platform records (${OUTCOMES.join(", ")})`);
    }
    // `closed_by` is stamped by the close act and is the evidence that the outcome was recorded
    // rather than typed. An outcome with no closed_by is a hand-written close.
    const closer = closingFm.closed_by ?? "";
    if (!closer) {
      problems.push(`${closing} carries outcome: ${outcome} with no closed_by — written by hand rather than recorded by initiative_close()`);
    } else if (team && closer.trim().toLowerCase() === team.trim().toLowerCase()) {
      problems.push(`${closing} closed_by names the team ('${closer}'), not a person`);
    }
    // `accepted_by` appears only when somebody actually accepted, and then it must be a
    // person. `delivered` carries no acceptor by definition and owes a reason instead.
    const who = closingFm.accepted_by ?? "";
    if (outcome === "accepted" && !who) {
      problems.push(`${closing} closed as accepted with no accepted_by`);
    } else if (who && team && who.trim().toLowerCase() === team.trim().toLowerCase()) {
      problems.push(`${closing} accepted_by names the team ('${who}'), not a person`);
    }
    if (outcome === "delivered" && !closingFm.no_signoff_reason) {
      problems.push(`${closing} closed as delivered with no no_signoff_reason — an unsigned close owes a sentence saying why`);
    }
  }

  // An initiative that stopped is not a defective one: one that was dropped is precisely one whose
  // gates were never passed, so requiring them here would leave two options — approve a plan
  // nobody agreed to, or leave the initiative open forever.
  // COUPLED: closeCheck exempts every gate but the closing document's own when the outcome is a
  // stop, and this audit has to exempt the same ones or it reports defects the platform does not
  // have.
  const stopped = outcome === OUTCOME_STOPPED;
  for (const d of docs) {
    const f = join(folder, d.name);
    if (!existsSync(f)) {
      // What a close depends on. closeCheck requires every `requiredForClose` document to exist
      // whatever the outcome, and initiative_close() refuses outright when the closing document is
      // not written. A gated document that was never written is requiredForClose's business, not
      // the gate's.
      if (closed && (d.requiredForClose || d.closing)) {
        problems.push(`missing ${d.name} (closed initiative)`);
      }
      continue;
    }
    const status = frontmatter(f).status ?? "";
    // From the contract, not spelled again here: a second copy of the status vocabulary is one
    // that can disagree with the platform's.
    if (status && !(STATUSES as readonly string[]).includes(status)) {
      problems.push(`${d.name} status invalid: '${status}' (expected ${STATUSES.join(" or ")})`);
    }
    // The closing document's own gate holds whatever the outcome — closeCheck applies it before
    // the stop exemption, because a close is itself a write to that document and a signature has
    // to cover the bytes it signed. Every other gate is exempt once the work stopped.
    if (d.gate && closed && (!stopped || d.closing) && status !== "approved") {
      problems.push(`${d.name} gate never recorded (status=${status || "missing"})`);
    }
  }

  const activity = join(folder, "activity.jsonl");
  if (existsSync(activity)) {
    if (!readFileSync(activity, "utf8").trim()) problems.push("activity.jsonl empty");
  } else {
    problems.push("no activity telemetry");
  }
  return { problems, closed };
}

function stageOrder(store: string, stages: string[]): string[] {
  const log = join(store, "_activity.jsonl");
  if (stages.length === 0 || !existsSync(log)) return [];
  const first = new Map<string, string>();
  for (const line of readFileSync(log, "utf8").split("\n")) {
    let e: { action?: string; skill?: string; ts?: string };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue;
    }
    const skill = e.skill ?? "";
    if (e.action === "skill_read" && stages.includes(skill) && !first.has(skill)) {
      first.set(skill, e.ts ?? "");
    }
  }
  // A stage may legitimately appear twice — sdlc-flow audits after the spec and again after the
  // plan — and a repeat can only sort next to its twin in a list ordered by first load. The claim
  // is about first loads, so the declared order is reduced to first mentions too.
  const declared = [...new Set(stages)];
  const seen = declared.filter((s) => first.has(s));
  const byTime = [...seen].sort((a, b) => (first.get(a) ?? "").localeCompare(first.get(b) ?? ""));
  if (seen.join("\u0000") !== byTime.join("\u0000")) {
    return [`stage first-load order violated: ${byTime.join(" -> ")}`];
  }
  return [];
}

function main(argv: string[]): number {
  const args = parseArgs(argv, ["require-closed"]);
  const manifestPath = required(args, "manifest", "the flow.json whose discipline to audit against");
  const store = required(args, "store", "the team store directory to audit");
  const requireClosed = args.flags.has("require-closed");

  // Through @zz/catalog's reader. A manifest this audit accepted where the platform would not is
  // one it would audit a store against rules the platform never enforced. Same schema, same
  // strictness, and a sentence an operator can act on rather than a ZodError's wall of JSON.
  const read = manifestAt(manifestPath);
  if (!read.manifest) die(`--manifest ${manifestPath} ${read.why}`);
  const manifest = read.manifest;
  const docs = manifest.documents ?? [];
  // No fallback. Defaulting to one flow's filename would hardcode a flow's chain and could only
  // hide the manifest bug that produced it: a flow closing on outcome.md would be audited against
  // a spec.md that does not exist, find no outcome, conclude the initiative is open, and skip every
  // gate check. The release gate already requires this field.
  const closing = docs.find((d) => d.closing)?.name;
  if (!closing) {
    console.log(`AUDIT: ${manifestPath} declares no closing document — nothing can be audited`);
    return 2;
  }
  if (!existsSync(store)) {
    console.log("AUDIT: store not found");
    return 2;
  }

  // Dot-entries are not initiatives. A team's store is a git repository, so every one holds a
  // `.git`, and auditing it reported `no activity telemetry` on a store where nothing was wrong.
  const folders = readdirSync(store)
    .filter((n) => !n.startsWith("_") && !n.startsWith(".") && statSync(join(store, n)).isDirectory())
    .sort()
    .map((n) => join(store, n));
  if (folders.length === 0) console.log("AUDIT: no initiatives");

  let failed = 0;
  let openCount = 0;
  for (const folder of folders) {
    // The store directory is the team slug — the same name the platform refuses in
    // approved_by and accepted_by, so the audit needs no second source for it.
    const { problems, closed } = auditInitiative(folder, docs, closing, basename(store));
    if (problems.length) {
      failed++;
      console.log(`AUDIT ${basename(folder)}: FAIL(${problems.join("; ")})`);
    } else if (!closed) {
      openCount++;
      console.log(`AUDIT ${basename(folder)}: OPEN — never closed, so nothing here is proven`);
    } else {
      console.log(`AUDIT ${basename(folder)}: PASS`);
    }
  }
  // Counted apart from the initiatives. Stage order is a property of the store — one verdict for
  // the whole run — and folding it into `failed` subtracts it from the count of clean initiatives
  // while naming no initiative as the one at fault.
  let storeProblems = 0;
  for (const p of stageOrder(store, (manifest.stages ?? []).map((s) => s.name))) {
    storeProblems++;
    console.log(`AUDIT stage-order: FAIL(${p})`);
  }

  // Exit non-zero when anything failed. This is named as an acceptance check, and a verification
  // tool that prints FAIL and returns success cannot fail.
  const clean = folders.length - failed - openCount;
  const tail = openCount ? `, ${openCount} still open` : "";
  console.log(`AUDIT: ${clean}/${folders.length} initiatives closed and clean${tail}` +
              (storeProblems ? `, and ${storeProblems} problem(s) with the store itself` : ""));
  // An open initiative is not a defect in itself — a flow in progress is exactly that. It is a
  // defect where every initiative was meant to be driven to a close, so the caller says which it
  // is rather than this file guessing.
  if (openCount && requireClosed) {
    console.log("AUDIT: FAIL — --require-closed was given and some initiatives never closed");
    return 1;
  }
  return failed || storeProblems ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
