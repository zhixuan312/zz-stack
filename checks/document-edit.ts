#!/usr/bin/env node
/**
 * checks/document-edit.ts — the walking skeleton of `document_edit`: one command that runs
 * create → edit → present → approve end to end through the real MCP door.
 *
 *   node checks/document-edit.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL (`withThrowawayDb`), seeds one principal in one team, starts
 * the built zz-core on a free port against that database, and, with that principal's identity
 * headers, opens a freeform initiative, writes `notes.md`, applies a two-edit `document_edit`,
 * reads the body back byte-equal, presents it and approves it. Between the edit and the present
 * it asserts that a repeated `find` is refused with its line numbers (`MULTIPLE_MATCHES`) and
 * changes nothing, and that a `section` change lands in the same version. After the approval it
 * asserts that a body change naming no cause is refused (`CAUSE_REQUIRED`) and changes nothing,
 * and that the same change with its cause as `source_content` opens v2.
 *
 * The only database it touches is the one it started; the zz-core child is killed and the
 * container removed on every exit path.
 *
 * Exit 0: the skeleton ran — one line per step, then the final line.
 * Exit 1: a step failed — the step and the tool's reply text.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

import { documentBody } from "@zz/contracts";
import { Mcp } from "@zz/mcp-client";
import pg from "pg";

import { root } from "../scripts/deployment.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const EMAIL = "skeleton@example.test";
const TEAM = "skeleton-team";
const START_TIMEOUT_MS = 30_000;

class StepFailure extends Error {}

function fail(step: string, detail: string): never {
  throw new StepFailure(`document-edit skeleton: FAILED at "${step}": ${detail}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/** Starts zz-core and resolves once its stdout says it is listening on `port`. */
function startCore(url: string, port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["services/zz-core/dist/server.js", "--port", String(port)], {
      cwd: root,
      env: {
        ...process.env,
        TEAM_DB_URL: url,
        TRUSTED_PEERS: "localhost",
        ZZ_CATALOG_DIR: `${root}/catalog`,
        ZZ_SKILLS_DIR: `${root}/skills`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let seen = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new StepFailure(
        `document-edit skeleton: FAILED at "start zz-core": no \`listening on :${port}\` within ` +
        `${START_TIMEOUT_MS / 1000}s. Output so far: ${seen.trim() || "(none)"}`));
    }, START_TIMEOUT_MS);
    const onData = (b: Buffer): void => {
      seen += b.toString();
      if (seen.includes(`listening on :${port}`)) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (err) => { clearTimeout(timer); reject(err); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new StepFailure(
        `document-edit skeleton: FAILED at "start zz-core": exited (${code ?? signal}) before listening. ` +
        `Output: ${seen.trim() || "(none)"}`));
    });
  });
}

async function seed(db: pg.Client): Promise<void> {
  const p = await db.query<{ id: string }>(
    "INSERT INTO zz.principal (email, display_name, role) VALUES ($1, 'Skeleton', 'member') RETURNING id", [EMAIL]);
  const principal = p.rows[0].id;
  const t = await db.query<{ id: string }>(
    "INSERT INTO zz.team (slug, name, created_by) VALUES ($1, 'Skeleton team', $2) RETURNING id", [TEAM, principal]);
  const team = t.rows[0].id;
  await db.query(
    "INSERT INTO zz.membership (team_id, principal_id, role, added_by) VALUES ($1, $2, 'admin', $2)", [team, principal]);
  await db.query("UPDATE zz.principal SET active_team_id = $1 WHERE id = $2", [team, principal]);
}

async function run(db: pg.Client, url: string): Promise<void> {
  await seed(db);
  const port = await freePort();
  const child = await startCore(url, port);
  try {
    const mcp = new Mcp(`http://127.0.0.1:${port}/mcp`, {
      client: "document-edit-check",
      timeoutMs: 30_000,
      headers: {
        "x-zz-user-email": EMAIL, "x-zz-user-name": "Skeleton", "x-zz-user-id": "",
        "x-zz-user-role": "user", "x-zz-via": "forwarded", "x-zz-pat-team": "", "x-zz-session-team": "",
      },
    });
    const call = async (step: string, tool: string, args: unknown): Promise<string> => {
      let reply: string;
      try {
        reply = await mcp.call(tool, args);
      } catch (err) {
        const msg = (err as Error).message;
        if (/not a trusted caller/.test(msg)) {
          fail(step, `${msg} — zz-core refused this peer; TRUSTED_PEERS must resolve to the address the check calls from`);
        }
        fail(step, msg);
      }
      if (/not a trusted caller/.test(reply)) {
        fail(step, `${reply} — TRUSTED_PEERS must resolve to the address the check calls from`);
      }
      return reply;
    };
    const ok = async (step: string, tool: string, args: unknown): Promise<string> => {
      const reply = await call(step, tool, args);
      if (reply.startsWith("ERROR")) fail(step, reply);
      console.log(`  ${step}: ok`);
      return reply;
    };
    const refused = async (step: string, tool: string, args: unknown, expect: RegExp): Promise<void> => {
      const reply = await call(step, tool, args);
      if (!reply.startsWith("ERROR") || !expect.test(reply)) fail(step, `expected a refusal matching ${expect}, got: ${reply}`);
      console.log(`  ${step}: refused as expected`);
    };

    const opened = await ok("initiative_open", "initiative_open", { slug: "edit-skeleton" });
    let name: string;
    try {
      name = (JSON.parse(opened) as { initiative: string }).initiative;
    } catch {
      return fail("initiative_open", `reply was not JSON: ${opened}`);
    }
    const path = `${name}/notes.md`;
    // Every byte of the body is compared, from its first character: `documentBody` returns what
    // the author wrote, without the separator (checks/document-body-roundtrip.ts).
    const bodyOf = async (step: string): Promise<string> =>
      documentBody(await call(step, "document_read", { path }));

    const original = "# Notes\n\nalpha line\n\nbeta line\n";
    const edited = "# Notes\n\nALPHA LINE\n\nBETA LINE\n";

    await ok("document_write", "document_write", { path, content: original });
    if ((await bodyOf("document_read (created)")) !== original) {
      fail("document_read (created)", `body differs from what was written: ${JSON.stringify(await bodyOf("document_read"))}`);
    }

    await ok("document_edit (2 edits)", "document_edit", {
      path, edits: [{ find: "alpha line", replace: "ALPHA LINE" }, { find: "beta line", replace: "BETA LINE" }],
    });
    const afterEdit = await bodyOf("document_read (edited)");
    if (afterEdit !== edited) {
      fail("document_read (edited)", `expected ${JSON.stringify(edited)}, got ${JSON.stringify(afterEdit)}`);
    }
    console.log("  document_read (edited): byte-equal");

    const unchanged = async (step: string, want: string): Promise<void> => {
      const now = await bodyOf(step);
      if (now !== want) fail(step, `the refused call changed the body: ${JSON.stringify(now)}`);
    };

    // Lines 3 and 5 are where `LINE` sits in what the author wrote. Before documentBody dropped the
    // envelope separator the tool answered 6 and 8 (checks/document-body-roundtrip.ts).
    await refused("document_edit repeated find", "document_edit",
      { path, edits: [{ find: "LINE", replace: "x" }] }, /^ERROR: MULTIPLE_MATCHES — edit 0 \(0-based\): `find` occurs 2 times, on lines 3, 5 of the body/);
    await unchanged("document_read (after MULTIPLE_MATCHES)", edited);
    // A draft's section changes in place: no cause, so the same public version.
    const bySection = "# Notes\n\nALPHA LINE\n\nBETA LINE, by section\n";
    const sectioned = await ok("document_edit with section", "document_edit",
      { path, section: "Notes", content: bySection });
    if (sectioned.split("\n")[0] !== `edited: ${path} — v1`) {
      fail("document_edit with section", `expected the first line \`edited: ${path} — v1\`, got: ${sectioned}`);
    }
    await unchanged("document_read (after section)", bySection);

    await ok("document_present", "document_present", { path });
    await ok("document_approve", "document_approve", { path });

    // An approved body changes only with its cause, and the change opens the next version.
    const lower = { path, edits: [{ find: "ALPHA", replace: "alpha" }] };
    await refused("document_edit on approved, no cause", "document_edit", lower, /^ERROR: CAUSE_REQUIRED — /);
    await unchanged("document_read (after the refused approved edit)", bySection);
    const caused = await ok("document_edit on approved, with its cause", "document_edit",
      { ...lower, source_content: "The stakeholder asked for the first line in lower case." });
    if (caused.split("\n")[0] !== `edited: ${path} — v2 (new version)` || !/^causes: .*\(agent\)/m.test(caused)) {
      fail("document_edit on approved, with its cause", `expected v2 as a new version with an agent cause, got: ${caused}`);
    }
    await unchanged("document_read (after the approved edit)", bySection.replace("ALPHA", "alpha"));
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const t = setTimeout(() => { child.kill("SIGKILL"); }, 5000);
      child.once("exit", () => { clearTimeout(t); resolve(); });
    });
  }
}

async function main(): Promise<number> {
  try {
    await withThrowawayDb((db) => run(db, dbUrl), async (url) => { dbUrl = url; });
  } catch (err) {
    if (err instanceof Error && /Docker is not running/.test(err.message)) {
      console.error("document-edit skeleton: Docker is not available — the check could not run, which is not a pass");
      return 2;
    }
    console.error(err instanceof StepFailure ? err.message : `document-edit skeleton: ${String((err as Error)?.stack ?? err)}`);
    return 1;
  }
  console.log("document-edit skeleton: create → edit (2) → present → approve: ok");
  return 0;
}

let dbUrl = "";
process.exitCode = await main();
