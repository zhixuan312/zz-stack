#!/usr/bin/env node
/**
 * checks/document-version-causes.ts — automatic causes, through a real zz-core on a throwaway
 * database (AC-1.3): which sources a change links by itself, to which version, and which it never
 * links.
 *
 *   node checks/document-version-causes.ts   # needs Docker and a built tree (`npm run build`)
 *
 * A source is owed to a document when it declares it supports it, no version of that document
 * cites it yet, and its current revision was filed at or after the cause-link epoch
 * (`zz.cause_link_epoch`). What it establishes, one line per case:
 *
 *   - a source filed before its target existed is linked to v1 by the create, and the sources a
 *     create names and the words it captures are linked to v1 as the agent's;
 *   - a malformed `sources` entry is `INVALID_MODE` on a create as on an edit;
 *   - a source filed after the epoch is linked by the next body change, as the platform's, and
 *     opens the next version;
 *   - a metadata-only call and a `no_change` call consume no owed source — the body change after
 *     them still links it;
 *   - a source both named and owed is linked once, as the agent's;
 *   - one source supporting two documents is linked to each;
 *   - a source whose revision is put before the epoch, and one whose `written_at` is null, are
 *     never linked — an approved document's change then needs its cause named;
 *   - a source filed while its target's create waits on the lock is linked by that create or owed
 *     by the next change, never lost;
 *   - a typo edit that links an audit round by itself does not settle the audit: after it, and
 *     after a later approval, `initiative_status` still owes the round on the new version.
 *
 * Setup writes only the database the check started: the epoch is moved, and a `written_at`
 * nulled, with SQL on it.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { type Core, withThrowawayCore } from "../scripts/schema/throwaway-core.ts";

const NAME = "document-version-causes";

const first = (reply: string): string => reply.split("\n")[0];
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const citesSource = (cited: string[], src: string): boolean => cited.some((x) => x.startsWith(`${src} `));

async function run(c: Core): Promise<void> {
  const I = await c.open("causes");
  const a = `${I}/a.md`;

  // ---- a source filed before its target existed
  {
    const step = "a source filed before its target existed is linked to v1 by the create";
    const early = await c.source(step, { initiative: I, title: "Early material", content: "words", supports: "a.md" });
    const created = await c.ok(step, "document_write", { path: a, content: "# A\n\nalpha\n" });
    if (!new RegExp(`^causes \\(1\\): ${esc(early)} \\(platform\\)$`, "m").test(created)) c.fail(step, `receipt: ${created}`);
    const cited = await c.cites(a);
    if (!cited.includes(`${early} platform v1`)) c.fail(step, `v1 cites ${JSON.stringify(cited)}`);
    c.pass(step);
  }

  // ---- named and captured causes on a create
  {
    const step = "a create links the sources it names and the words it captures to v1, as the agent's";
    const named = await c.source(step, { initiative: I, title: "Named on create", content: "the brief" });
    const g = `${I}/g.md`;
    const created = await c.ok(step, "document_write",
      { path: g, content: "# G\n\ngee\n", sources: [named.slice(I.length + 1)], source_content: "what the call said" });
    const listed = /^causes \(\d+\): (.*)$/m.exec(created)?.[1].split(", ") ?? [];
    const captured = listed.find((x) => x !== `${named} (agent)`) ?? "";
    if (listed.length !== 2 || !listed.includes(`${named} (agent)`)
        || !new RegExp(`^${esc(I)}/sources/\\d{4}-\\d{2}-\\d{2}-input-behind-v1\\.md \\(agent\\)$`).test(captured)) {
      c.fail(step, `receipt: ${created}`);
    }
    const cited = await c.cites(g);
    if (!cited.includes(`${named} agent v1`) || !cited.includes(captured.replace(" (agent)", " agent v1"))) {
      c.fail(step, `v1 cites ${JSON.stringify(cited)}`);
    }
    c.pass(step);
  }

  // ---- a malformed sources entry
  {
    const step = "a malformed `sources` entry is INVALID_MODE on a create as on an edit";
    const bad = /^ERROR: INVALID_MODE — source "\.\.\/x" must be a path inside the initiative/;
    await c.refused(step, "document_write", { path: `${I}/never.md`, content: "# Never\n", sources: ["../x"] }, bad);
    await c.refused(step, "document_edit", { path: a, edits: [{ find: "alpha", replace: "beta" }], sources: ["../x"] }, bad);
    await c.refused(step, "document_read", { path: `${I}/never.md` }, /does not exist/);
    c.pass(step);
  }

  // ---- a source filed after the epoch
  {
    const step = "a source filed after the epoch is linked by the next body change, as the platform's";
    const later = await c.source(step, { initiative: I, title: "Later material", content: "more words", supports: "a.md" });
    const edited = await c.ok(step, "document_edit", { path: a, edits: [{ find: "alpha", replace: "beta" }] });
    if (first(edited) !== `edited: ${a} — v2 (new version)`) c.fail(step, edited);
    if (!new RegExp(`^causes \\(1\\): ${esc(later)} \\(platform\\)$`, "m").test(edited)) c.fail(step, edited);
    if (!(await c.cites(a)).includes(`${later} platform v2`)) c.fail(step, JSON.stringify(await c.cites(a)));
    c.pass(step);
  }

  // ---- metadata-only and no_change consume nothing
  {
    const step = "a metadata-only call and a no_change call consume no owed source";
    const owed = await c.source(step, { initiative: I, title: "Owed material", content: "owed words", supports: "a.md" });
    const titled = await c.ok(step, "document_edit", { path: a, title: "A titled" });
    if (first(titled) !== `edited: ${a} — v2` || !/^causes \(0\): none$/m.test(titled)) c.fail(step, `metadata-only: ${titled}`);
    const same = await c.ok(step, "document_edit", { path: a, title: "A titled" });
    if (first(same) !== `edited: ${a} — v2 (no change)`) c.fail(step, `no_change: ${same}`);
    if (citesSource(await c.cites(a), owed)) c.fail(step, "the owed source was consumed before a body change");
    // Still owed, and filed long before the change that links it: no lower bound but the epoch.
    const body = await c.ok(step, "document_edit", { path: a, edits: [{ find: "beta", replace: "gamma" }] });
    if (first(body) !== `edited: ${a} — v3 (new version)` || !new RegExp(`${esc(owed)} \\(platform\\)`).test(body)) {
      c.fail(step, `the body change after them: ${body}`);
    }
    c.pass(step);
  }

  // ---- named and owed
  {
    const step = "a source both named and owed is linked once, as the agent's";
    const both = await c.source(step, { initiative: I, title: "Named and owed", content: "both", supports: "a.md" });
    const rel = both.slice(I.length + 1);
    const edited = await c.ok(step, "document_edit", { path: a, edits: [{ find: "gamma", replace: "delta" }], sources: [rel] });
    const line = /^causes \(\d+\): (.*)$/m.exec(edited)?.[1] ?? "";
    if (line !== `${both} (agent)`) c.fail(step, `causes line: ${line}`);
    const links = (await c.cites(a)).filter((x) => x.startsWith(`${both} `));
    if (JSON.stringify(links) !== JSON.stringify([`${both} agent v4`])) c.fail(step, JSON.stringify(links));
    c.pass(step);
  }

  // ---- one source, two documents
  {
    const step = "one source supporting two documents is linked to each";
    const [b, cc] = [`${I}/b.md`, `${I}/c.md`];
    await c.ok(step, "document_write", { path: b, content: "# B\n\nbee\n" });
    await c.ok(step, "document_write", { path: cc, content: "# C\n\nsea\n" });
    const shared = await c.source(step, { initiative: I, title: "Shared material", content: "for both", supports: ["b.md", "c.md"] });
    for (const [p, find] of [[b, "bee"], [cc, "sea"]] as const) {
      const edited = await c.ok(step, "document_edit", { path: p, edits: [{ find, replace: find.toUpperCase() }] });
      if (first(edited) !== `edited: ${p} — v2 (new version)` || !new RegExp(`${esc(shared)} \\(platform\\)`).test(edited)) {
        c.fail(step, `${p}: ${edited}`);
      }
    }
    c.pass(step);
  }

  // ---- before the epoch
  {
    const step = "a source whose revision is put before the epoch is never linked";
    const d = `${I}/d.md`;
    await c.ok(step, "document_write", { path: d, content: "# D\n\ndee\n" });
    await c.sign(d);
    const old = await c.source(step, { initiative: I, title: "Pre-release material", content: "old", supports: "d.md" });
    const { rows: [{ epoch }] } = await c.sql.query<{ epoch: string }>("select epoch::text as epoch from zz.cause_link_epoch");
    // The epoch moved to just after the source's revision — the setup step writes only this database.
    await c.sql.query(
      `update zz.cause_link_epoch set epoch = (
         select r.written_at + interval '1 millisecond' from zz.doc s
           join zz.initiative i on i.id = s.initiative_id
           join zz.doc_revision r on r.doc_id = s.id and r.revision = s.current_revision
          where i.slug || '/' || s.path = $1)`, [old]);
    try {
      // Approved, so a body change needs a cause, and the only candidate is the old source.
      await c.refused(step, "document_edit", { path: d, edits: [{ find: "dee", replace: "DEE" }] }, /^ERROR: CAUSE_REQUIRED — /);
      if (citesSource(await c.cites(d), old)) c.fail(step, "the pre-epoch source was linked");
      // Named, it is the agent's cause like any other.
      const named = await c.ok(step, "document_edit",
        { path: d, edits: [{ find: "dee", replace: "DEE" }], sources: [old.slice(I.length + 1)] });
      if (first(named) !== `edited: ${d} — v2 (new version)` || !new RegExp(`^causes \\(1\\): ${esc(old)} \\(agent\\)$`, "m").test(named)) {
        c.fail(step, `named: ${named}`);
      }
    } finally {
      await c.sql.query("update zz.cause_link_epoch set epoch = $1::timestamptz", [epoch]);
    }
    c.pass(step);
  }

  // ---- written_at null
  {
    const step = "a source whose written_at is null is never linked";
    const e = `${I}/e.md`;
    await c.ok(step, "document_write", { path: e, content: "# E\n\nee\n" });
    const undated = await c.source(step, { initiative: I, title: "Undated material", content: "when?", supports: "e.md" });
    await c.sql.query(
      `update zz.doc_revision r set written_at = null from zz.doc s join zz.initiative i on i.id = s.initiative_id
        where r.doc_id = s.id and i.slug || '/' || s.path = $1`, [undated]);
    const edited = await c.ok(step, "document_edit", { path: e, edits: [{ find: "ee", replace: "EE" }] });
    if (first(edited) !== `edited: ${e} — v1` || !/^causes \(0\): none$/m.test(edited)) c.fail(step, edited);
    if (citesSource(await c.cites(e), undated)) c.fail(step, "the undated source was linked");
    c.pass(step);
  }

  // ---- a source filed while its target is being created
  {
    const step = "a source filed while its target's create waits is linked by the create or owed by the next change";
    const f = `${I}/f.md`;
    const key = c.docKey(f);
    await c.hold(key);
    let creating: Promise<string>;
    let racing: string;
    try {
      // The create computes its causes, then waits on the lock; the source lands meanwhile.
      creating = c.call(step, "document_write", { path: f, content: "# F\n\neff\n" });
      await c.waiters(step, key, 1);
      racing = await c.source(step, { initiative: I, title: "Racing material", content: "meanwhile", supports: "f.md" },
                            c.client());
    } finally {
      await c.release(key);
    }
    const created = await creating;
    if (created.startsWith("ERROR")) c.fail(step, created);
    let by = "the create";
    if (!citesSource(await c.cites(f), racing)) {
      by = "the next change";
      const edited = await c.ok(step, "document_edit", { path: f, edits: [{ find: "eff", replace: "EFF" }] });
      if (!new RegExp(`${esc(racing)} \\(platform\\)`).test(edited)) c.fail(step, `lost: ${edited}`);
    }
    if (!citesSource(await c.cites(f), racing)) c.fail(step, "the racing source is cited by no version");
    console.log(`  ${step}: ok (linked by ${by})`);
  }

  // ---- the typo edit and the audit
  {
    const step = "a typo edit that links an audit round does not settle the audit, before or after approval";
    const T = await c.open("typo-audit", "sdlc-flow");
    const spec = `${T}/spec.md`;
    const plan = `${T}/plan.md`;
    await c.ok(step, "document_write", { path: `${T}/explore.md`, content: "## Background\nx\n\n## Current state\nx\n\n## Rough direction\nx\n" });
    await c.ok(step, "document_write", { path: spec, content: SPEC_BODY });
    await c.sign(spec);
    await c.source(step, { initiative: T, title: "spec audit round 1", content: "no blocking findings",
                            supports: ["spec.md"], stage: "sdlc-spec-audit" });
    await c.ok(step, "document_write", { path: plan, content: "## Full-suite gate\nRun the gate.\n" });
    await c.sign(plan);
    const round = await c.source(step, { initiative: T, title: "plan audit round 1", content: "one finding: say which gate",
                                          supports: ["plan.md"], stage: "sdlc-plan-audit" });
    const settled = (await c.status(T)).next_move ?? {};
    // NOT A TOOL: `add_source` is next_move's own action vocabulary; the call it asks for is source_add.
    if (settled.document === "plan.md" && settled.action === "add_source") c.fail(step, `round 1 on v1 did not settle v1: ${JSON.stringify(settled)}`);
    const typo = await c.ok(step, "document_edit", { path: plan, edits: [{ find: "Run the gate.", replace: "Run the gate!" }] });
    if (first(typo) !== `edited: ${plan} — v2 (new version)` || !new RegExp(`^causes \\(1\\): ${esc(round)} \\(platform\\)$`, "m").test(typo)) {
      c.fail(step, `the typo edit: ${typo}`);
    }
    const owes = (when: string, move: { action?: string; document?: string; why?: string }): void => {
      // NOT A TOOL: `add_source` is next_move's own action vocabulary; the call it asks for is source_add.
      if (move.action !== "add_source" || move.document !== "plan.md" || !/plan\.md is v2; round 1 read v1/.test(move.why ?? "")) {
        c.fail(step, `${when}: expected the round owed on plan.md v2, got ${JSON.stringify(move)}`);
      }
    };
    owes("after the typo edit", (await c.status(T)).next_move ?? {});
    await c.sign(plan);
    owes("after the approval", (await c.status(T)).next_move ?? {});
    c.pass(step);
  }
}

/** A spec the spec gate approves: every declared section, one phase, one core statement with its
 *  evidence (scripts/control-loop-e2e.ts). */
const SPEC_BODY =
  "## Context\nx\n\n## Problem\nx\n\n## Goals & Requirements\nx\n\n## Alternatives\nx\n\n" +
  "## Approach, Method & Structure\nx\n\n## Verification Plan\nx\n\n## Risks & Mitigations\nx\n\n" +
  "## Stakeholders & Work\nx\n\n" +
  "## Phase outline\n- **Phase 0 — Loop:** the control loop runs end to end.\n\n" +
  "## Core statements\n| ID | Statement | If false | Status | Evidence | Note |\n|---|---|---|---|---|---|\n" +
  "| CS-1 | The loop runs. | Nothing is checked. | fails | run:control-loop-e2e — `loop` | resolved-by-design-change: a probe has no design |\n";

process.exitCode = await withThrowawayCore(NAME,
  `${NAME}: owed sources link by themselves from the epoch on, once per target, never lost and never settling an audit: ok`, run);
