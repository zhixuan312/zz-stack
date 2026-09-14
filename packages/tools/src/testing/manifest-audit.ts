/**
 * manifest-audit — the platform's mechanical outcome audit (generic).
 *
 * Reads the FLOW's manifest (flow.json) and audits a team store against the discipline the
 * flow itself declares — the platform never hardcodes any flow's chain. Pure code; PASS
 * means the artifacts mechanically prove the flow ran right, FAIL names the defect.
 *
 *   npm run audit -- --manifest catalog/<owner>/<flow>/flow.json \
 *                    --store /var/lib/docker/volumes/zz_zz-artifacts/_data/teams/<team>
 *                    [--require-closed]   # an initiative still open is a FAIL, for CI
 *
 * IT IMPORTS THE ENVELOPE PARSER. This used to carry a second implementation of it — "the
 * Python half of ONE envelope parser" — held to the TypeScript original by a gate check that
 * compared three regexes as string literals. That is the best a cross-language duplicate can
 * do, and it was not good enough: the two had already drifted once, this half closing on
 * `\n---\s*\n` where the platform closes on `\n---`, so a document ending exactly at its
 * fence had a full envelope to the platform and no envelope at all to the audit.
 *
 * There is one parser now. An audit that reads an envelope differently from the platform
 * that wrote it reports defects the platform does not have and misses the ones it does, and
 * the only way to be sure it cannot is to run the same code.
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
 * (defects, closed). Whether it CLOSED is reported separately from whether what exists is
 * well-formed, because almost every check below applies only to a closed initiative — so an
 * unfinished one skips them and looks identical to a clean pass. A round that left three
 * initiatives open reported "6/6 initiatives clean".
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

  // `outcome: accepted` is a claim about what a PERSON said, and this audit used to read
  // only whether the word was there. A live smoke run closed an initiative as accepted, with
  // a ledger row, while the scripted stakeholder had accepted nothing — and this audit called
  // it PASS, because nothing in the artifacts distinguished their verdict from the agent's
  // account of one. The platform refuses such a close now; the audit has to be able to see it
  // too, or it passes the one defect it exists to catch.
  //
  // EVERY outcome is somebody's verdict, not only `accepted`. Reading the name only on
  // `accepted` left `delivered` — the same finished initiative, the same ledger row — as a
  // close this audit would pass while it named nobody. `abandoned` is a decision too, and
  // "who decided to stop" is exactly what a ledger row gets read to answer later.
  if (outcome) {
    // THE WORD ITSELF. Every rule below is written against a known outcome, so a word that is
    // not one of them fell through all of them and the initiative was reported PASS — while
    // the audit's whole purpose is to catch a store edited outside the platform, which is the
    // only way an unknown outcome can get there. `superseded` was an outcome until this
    // release and would still have passed silently.
    if (!(OUTCOMES as readonly string[]).includes(outcome)) {
      problems.push(`${closing} carries outcome: '${outcome}', which is not an outcome this ` +
                    `platform records (${OUTCOMES.join(", ")})`);
    }
    // `closed_by` is stamped by the close ACT and is the audit's evidence that the outcome
    // was recorded rather than typed. An outcome with no closed_by is a hand-written close,
    // which is the one shape this audit exists to catch.
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

  // AN INITIATIVE THAT STOPPED IS NOT A DEFECTIVE ONE, and the platform says so in as many
  // words: "an initiative that was dropped is precisely one whose gates were never passed, so
  // requiring them here would leave two options — approve a plan nobody agreed to, or leave
  // the initiative open forever". closeCheck exempts every gate but the closing document's own
  // when the outcome is a stop.
  //
  // This audit did not, and it exists to be believed. Measured on a store holding one
  // correctly abandoned ops-flow initiative, it reported four defects, two of which the
  // platform does not have: `intent.md gate never recorded` on a gate the platform exempts,
  // and `missing plan.md` on a gated document the platform never requires to exist. That is
  // the failure this file's own docstring names about carrying a second copy of a rule —
  // reporting defects nobody has and missing the ones they do.
  const stopped = outcome === OUTCOME_STOPPED;
  for (const d of docs) {
    const f = join(folder, d.name);
    if (!existsSync(f)) {
      // What a close DEPENDS on. closeCheck requires every `requiredForClose` document to
      // exist whatever the outcome, and initiative_close() refuses outright when the closing document is
      // not written. A GATED document that was never written is requiredForClose's business,
      // not the gate's — that is closeCheck's own division, and this had merged the two.
      if (closed && (d.requiredForClose || d.closing)) {
        problems.push(`missing ${d.name} (closed initiative)`);
      }
      continue;
    }
    const status = frontmatter(f).status ?? "";
    // From the contract, not spelled again here. A second copy of the status vocabulary is a
    // copy that can disagree with the platform's, and this audit exists to be believed.
    if (status && !(STATUSES as readonly string[]).includes(status)) {
      problems.push(`${d.name} status invalid: '${status}' (expected ${STATUSES.join(" or ")})`);
    }
    // The closing document's OWN gate holds whatever the outcome — closeCheck applies it
    // before the stop exemption, because a close is itself a write to that document and a
    // signature has to cover the bytes it signed. Every other gate is exempt once the work
    // stopped.
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
  // A stage may legitimately appear twice — sdlc-flow audits after the spec and again after
  // the plan — and this compared the declared list against a list sorted by FIRST load, where
  // a repeat can only ever sort next to its twin. So a perfectly ordered sdlc-flow run
  // reported "stage first-load order violated". The claim is about first loads, so the
  // declared order has to be reduced to first mentions too.
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

  // Through @zz/catalog's reader. This audit exists to be believed, and a manifest it accepted
  // where the platform would not is one it would audit a store against rules the platform
  // never enforced — reporting defects nobody has and missing the ones they do, which is the
  // exact argument its own docstring makes about carrying a second envelope parser.
  //
  // `CatalogManifest.parse` did the validating and threw a ZodError when it failed, so an
  // operator who pointed --manifest at the wrong file got a wall of JSON instead of a
  // sentence. Same schema, same strictness, a reason they can act on.
  const read = manifestAt(manifestPath);
  if (!read.manifest) die(`--manifest ${manifestPath} ${read.why}`);
  const manifest = read.manifest;
  const docs = manifest.documents ?? [];
  // No fallback. This file's first claim is that the platform never hardcodes any flow's
  // chain, and defaulting to one flow's filename was exactly that. It could only ever hide
  // the manifest bug that produced it: a flow closing on outcome.md would be audited against
  // a spec.md that does not exist, find no outcome, conclude the initiative is open, and skip
  // every gate check there is. The release gate already requires this field.
  const closing = docs.find((d) => d.closing)?.name;
  if (!closing) {
    console.log(`AUDIT: ${manifestPath} declares no closing document — nothing can be audited`);
    return 2;
  }
  if (!existsSync(store)) {
    console.log("AUDIT: store not found");
    return 2;
  }

  // Dot-entries are not initiatives. A team's store is a git repository, so every one of them
  // holds a `.git` — and this audited it: `AUDIT .git: FAIL(no activity telemetry)`, on a
  // store where nothing was wrong, in a tool whose exit code is read as an acceptance check.
  const folders = readdirSync(store)
    .filter((n) => !n.startsWith("_") && !n.startsWith(".") && statSync(join(store, n)).isDirectory())
    .sort()
    .map((n) => join(store, n));
  if (folders.length === 0) console.log("AUDIT: no initiatives");

  let failed = 0;
  let openCount = 0;
  for (const folder of folders) {
    // The store directory IS the team slug — the same name the platform refuses in
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
  // Counted apart from the initiatives. Stage order is a property of the STORE — one verdict
  // for the whole run — and folding it into `failed` subtracted it from the count of clean
  // initiatives, so three clean initiatives plus one out-of-order stage reported "2/3 closed
  // and clean" and named no third initiative as the one at fault.
  let storeProblems = 0;
  for (const p of stageOrder(store, (manifest.stages ?? []).map((s) => s.name))) {
    storeProblems++;
    console.log(`AUDIT stage-order: FAIL(${p})`);
  }

  // Exit non-zero when anything failed. It printed FAIL and returned success, so anything
  // calling it as a command — which is how it is named as an acceptance check — read every
  // run as a pass. A verification tool that cannot fail is not one.
  const clean = folders.length - failed - openCount;
  const tail = openCount ? `, ${openCount} still open` : "";
  console.log(`AUDIT: ${clean}/${folders.length} initiatives closed and clean${tail}` +
              (storeProblems ? `, and ${storeProblems} problem(s) with the store itself` : ""));
  // An open initiative is not a defect in itself — a flow in progress is exactly that. It IS
  // a defect after a smoke round, where every scenario was driven to acceptance, so the
  // caller says which it is rather than this file guessing.
  if (openCount && requireClosed) {
    console.log("AUDIT: FAIL — --require-closed was given and some initiatives never closed");
    return 1;
  }
  return failed || storeProblems ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
