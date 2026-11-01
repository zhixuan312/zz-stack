#!/usr/bin/env node
/**
 * The six readers below take an initiative's "closed", "outcome" and "flow" from zz.initiative —
 * closed_at, outcome and flow on the row itself — never by scanning, aggregating or defaulting
 * over its documents.
 *
 * DELIBERATE: `initiative_status` (services/zz-core/src/tools/initiative-status.ts) is not one of
 * them. It reads the row first and falls back to the documents' `outcome` for a close the row
 * does not carry, and a freeform close names the document its outcome goes on — so extending this
 * check to that file would break freeform closes, which checks/initiative-open.ts requires.
 *
 * It does not forbid `outcome`/`flow`/`closed_by` appearing in a SELECT from zz.doc outright —
 * those are legitimate per-document metadata the console and knowledge_search still return
 * (a document's own outcome column, stamped only on a closing document, is provenance a reader
 * may want to see). What it forbids is these specific idioms: deriving the
 * initiative-level answer by scanning, aggregating or defaulting over those document columns.
 *
 * Source-level, like checks/attribution.ts: each rule names one exact construct, not a general
 * parse of "is this a derivation".
 *
 * Run: node checks/initiative-lifecycle-readers.ts   (also run by scripts/gate.ts)
 */
import { readFileSync } from "node:fs";

import { withoutComments } from "../scripts/gate/read.ts";

const fail: string[] = [];


interface Rule {
  pattern: RegExp; message: string;
  /** Test `pattern` against only what this matches first, not the whole file — so a field
   *  that is fine on one interface (DocRow.outcome, kept for a document's own metadata) can be
   *  forbidden on another (StageDoc, which stageOf must not read an outcome off) without one
   *  rule fighting the other. Defaults to the whole file. */
  within?: RegExp;
}
interface FileSpec { path: string; forbid: Rule[]; require: Rule[] }

const specs: FileSpec[] = [
  {
    path: "services/gateway/src/console/shared.ts",
    forbid: [
      { within: /interface StageDoc \{[^}]*\}/, pattern: /outcome\s*:\s*string\s*\|\s*null\s*;/,
        message: "StageDoc carries its own `outcome` field again — stageOf must take the " +
        "initiative's outcome as a `lifecycle` argument, never read it off a document." },
      { pattern: /\.find\(\(d\)\s*=>\s*d\.outcome\)/, message:
        "stageOf scans the document list for one that carries an outcome — that is deriving " +
        "the initiative's outcome from zz.doc again." },
      { pattern: /spec\?\.outcome/, message:
        "the no-manifest fallback reads the initiative's outcome off a document's own `outcome` " +
        "field (`spec?.outcome`) instead of the `lifecycle` argument." },
    ],
    require: [
      { pattern: /lifecycle:\s*InitiativeLifecycle/, message:
        "stageOf no longer takes an explicit `lifecycle: InitiativeLifecycle` argument — closed " +
        "and outcome have nowhere non-document to come from." },
    ],
  },
  {
    path: "services/gateway/src/console/initiatives.ts",
    forbid: [
      { pattern: /\.map\(\(d\)\s*=>\s*d\.flow\)\.find\(Boolean\)/, message:
        "an initiative's flow is derived by scanning its documents for one that carries a " +
        "`flow` (`docs.map((d) => d.flow).find(Boolean)`) — read it from zz.initiative.flow." },
      { pattern: /select\s+team_slug,\s*initiative,\s*flow,\s*path,\s*type,\s*status,\s*outcome/i,
        message: "the initiative-list query selects `flow`/`outcome` per document again — those " +
          "are the initiative's own columns now, read from the zz.initiative anchor query." },
    ],
    require: [
      { pattern: /from\s+zz\.initiative\s+i\s+join\s+zz\.team\s+t\s+on\s+t\.id\s*=\s*i\.team_id/,
        message: "no query here joins zz.initiative to zz.team for the anchor's flow/closed/outcome." },
      { pattern: /i\.closed_at\s+is\s+not\s+null\s+as\s+closed/, message:
        "no query reads `closed_at is not null` off zz.initiative as the initiative's `closed`." },
    ],
  },
  {
    path: "services/zz-core/src/eval/observe-facts.ts",
    forbid: [
      { pattern: /min\(outcome\)\s+as\s+outcome\s*\n?\s*from\s+live/, message:
        "the closes CTE aggregates zz.doc.outcome (`min(outcome) ... from live`) again instead " +
        "of reading zz.initiative.outcome." },
    ],
    require: [
      { pattern: /closes\s+as\s*\(select\s+i\.outcome[\s\S]*?from\s+zz\.initiative\s+i/, message:
        "the closes CTE no longer selects i.outcome from zz.initiative." },
      { pattern: /i\.closed_at\s+is\s+not\s+null/, message:
        "the closes CTE no longer filters on zz.initiative.closed_at is not null." },
    ],
  },
  {
    path: "services/zz-core/src/tools/knowledge-search.ts",
    forbid: [
      { within: /const SOURCE = `\(([\s\S]*?)\) k`;/,
        pattern: /select\s+initiative,\s*path,\s*flow,\s*type,\s*status,\s*outcome,\s*approved_by,\s*approved_at,\s*\n\s*updated_at,\s*title,\s*tags,\s*evidence,\s*superseded_by,\s*team_slug,\s*body,\s*body_tsv,\s*\n\s*'document' as subject\s*\n\s*from zz\.doc\s*\n\s*union/,
        message: "SOURCE's document arm reads flow/outcome straight off zz.doc again, with no " +
          "join to zz.initiative — every sibling of a closing document would go back to " +
          "reporting a null outcome." },
    ],
    require: [
      { within: /const SOURCE = `\(([\s\S]*?)\) k`;/, pattern: /left join zz\.initiative i on/,
        message: "SOURCE's document arm no longer joins zz.initiative for flow/outcome." },
    ],
  },
  {
    path: "packages/tools/src/ops/watch-results.ts",
    forbid: [
      { pattern: /docs\.filter\(\(d\)\s*=>\s*d\.outcome\)/, message:
        "closedInitiatives is built by filtering zz.doc rows for a truthy `outcome` again." },
    ],
    require: [
      { pattern: /join\s+zz\.initiative\s+i\s+on\s+i\.id\s*=\s*d\.initiative_id/,
        message: "the stuck-draft count does not reach a document's initiative through zz.initiative." },
      { pattern: /i\.closed_at\s+is\s+null/, message:
        "the stuck-draft count does not skip a closed initiative by zz.initiative.closed_at." },
    ],
  },
  {
    path: "scripts/doctor/layers/data.ts",
    forbid: [
      { pattern: /c\.outcome\s*<>\s*''/, message:
        "the gated-status probe still excludes a closed initiative's documents by self-joining " +
        "zz.doc on `outcome <> ''` — read zz.initiative.closed_at instead." },
    ],
    require: [
      { pattern: /join\s+zz\.initiative\s+i\s+on\s+i\.id\s*=\s*d\.initiative_id[\s\S]*?i\.closed_at\s+is\s+null/,
        message: "the gated-status probe no longer excludes a closed initiative's documents via " +
          "zz.initiative.closed_at." },
    ],
  },
];

for (const spec of specs) {
  let src: string;
  try {
    // Comments taken out, so a rule cannot be satisfied (or defeated) by prose alone.
    src = withoutComments(readFileSync(spec.path, "utf8"));
  } catch {
    fail.push(`${spec.path}: could not be read`);
    continue;
  }
  const scopeOf = (rule: Rule): string => rule.within ? (src.match(rule.within)?.[0] ?? "") : src;
  for (const rule of spec.forbid) {
    if (rule.pattern.test(scopeOf(rule))) fail.push(`${spec.path}: ${rule.message}`);
  }
  for (const rule of spec.require) {
    if (!rule.pattern.test(scopeOf(rule))) fail.push(`${spec.path}: ${rule.message}`);
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("initiative lifecycle readers: ok");
