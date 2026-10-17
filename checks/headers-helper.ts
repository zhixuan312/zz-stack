#!/usr/bin/env node
/**
 * The token reaches the platform through `node`, on any machine that runs Claude Code.
 *
 * Every plugin's `.mcp.json` runs a headers helper at connect time, and the skill-report hook asks
 * the same helper for the credential. The helper was a bash script run through its shebang, which
 * Windows cannot execute: no Authorization header was sent, every door answered 401, and nothing
 * was reported. It is a Node script now, run as `node <path>`, and this drives the built one:
 *
 *   1. the helper resolves the token as it always has — $ZZ_TOKEN when it is not empty, then the
 *      file $ZZ_TOKEN_FILE names, then ~/.zz/token — with every CR and LF removed from a file's
 *      token, and prints one JSON object of headers;
 *   2. with no token anywhere it prints only `X-ZZ-Client` and exits 0, so the connection is
 *      refused with an error the person can act on;
 *   3. a token holding a quote or a backslash still prints valid JSON;
 *   4. the skill-report script, beside it, reports a shelf skill with the token the helper found,
 *      and prints nothing; both files are written without the execute bit, which no step needs;
 *   5. the install's node line, the one a machine without bash runs, writes $ZZ_TOKEN to
 *      ~/.zz/token owner-only, tightens a looser file or ~/.zz left by an earlier install, refuses
 *      to write with no token, holds no character PowerShell, cmd or bash would rewrite, and
 *      writes what the helper then reads. Run here through sh; PowerShell is not on this machine.
 *
 * Run: node checks/headers-helper.ts   (needs a built tree: `npm run build`)
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const { headersHelper, skillReportScript, tokenWriteCommand } = await import(
  pathToFileURL(join(process.cwd(), "services/gateway/dist/package/skills.js")).href);

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const dir = mkdtempSync(join(tmpdir(), "zz-headers-"));
try {
  const scripts = join(dir, "scripts");
  mkdirSync(scripts);
  const helper = join(scripts, "zz-mcp-headers.mjs");
  writeFileSync(helper, headersHelper(), { mode: 0o644 });
  const home = join(dir, "home");
  mkdirSync(join(home, ".zz"), { recursive: true });
  const empty = join(dir, "nobody");
  mkdirSync(empty);

  /** What the helper prints under `env`, parsed, or why it could not be. */
  const headers = async (env: Record<string, string>): Promise<Record<string, string> | string> => {
    try {
      const { stdout } = await run("node", [helper], { env: { PATH: process.env.PATH ?? "", ...env }, timeout: 10_000 });
      return JSON.parse(stdout) as Record<string, string>;
    } catch (err) {
      return `failed: ${String((err as { stderr?: string }).stderr || err).slice(0, 200)}`;
    }
  };
  const bearer = (h: Record<string, string> | string) => typeof h === "string" ? h : h.Authorization;

  // 1. Resolution order
  writeFileSync(join(home, ".zz/token"), "tok-home\n");
  const named = join(dir, "named-token");
  writeFileSync(named, "tok-\r\nfi\rle\r\n");
  is(bearer(await headers({ HOME: home, ZZ_TOKEN: "tok-env", ZZ_TOKEN_FILE: named })) === "Bearer tok-env",
     "$ZZ_TOKEN is not the first source");
  is(bearer(await headers({ HOME: home, ZZ_TOKEN: "", ZZ_TOKEN_FILE: named })) === "Bearer tok-file",
     "an empty $ZZ_TOKEN does not fall through to $ZZ_TOKEN_FILE, with every CR and LF removed");
  is(bearer(await headers({ HOME: home })) === "Bearer tok-home", "~/.zz/token is not read when nothing else is set");
  is(bearer(await headers({ HOME: home, ZZ_TOKEN_FILE: "" })) === "Bearer tok-home",
     "an empty $ZZ_TOKEN_FILE does not fall back to ~/.zz/token");
  const full = await headers({ HOME: home });
  is(typeof full !== "string" && full["X-ZZ-Client"] === "zz-plugin" && Object.keys(full).length === 2,
     `the helper does not print exactly Authorization and X-ZZ-Client: ${JSON.stringify(full)}`);

  // 2. No token
  const none = await headers({ HOME: empty, ZZ_TOKEN_FILE: join(dir, "missing") });
  is(JSON.stringify(none) === '{"X-ZZ-Client":"zz-plugin"}', `with no token the helper prints ${JSON.stringify(none)}`);

  // 3. A token JSON has to escape
  is(bearer(await headers({ HOME: empty, ZZ_TOKEN: 'a"b\\c' })) === 'Bearer a"b\\c', "a token with a quote or a backslash does not survive");

  // 4. The hook, through the helper beside it
  const seen: { auth?: string; client?: string; body?: string }[] = [];
  const core = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; }).on("end", () => {
      seen.push({ auth: req.headers.authorization, client: String(req.headers["x-zz-client"] ?? ""), body });
      res.setHeader("content-type", "application/json");
      res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
  });
  await new Promise<void>((ok) => core.listen(0, "127.0.0.1", ok));
  try {
    const port = (core.address() as { port: number }).port;
    const report = join(scripts, "zz-skill-report.mjs");
    writeFileSync(report, skillReportScript(`http://127.0.0.1:${port}/core/mcp`, ["zz-core"]), { mode: 0o644 });
    const child = execFile("node", [report], { env: { PATH: process.env.PATH ?? "", HOME: home }, timeout: 15_000 });
    child.stdin?.end(JSON.stringify({ tool_name: "Skill", tool_input: { skill: "zz-core:zz-platform" } }));
    let out = "";
    child.stdout?.on("data", (d) => { out += d; });
    const code = await new Promise<number | null>((ok) => child.on("close", ok));
    is(code === 0 && out === "", `the hook exited ${code} and printed ${JSON.stringify(out.slice(0, 80))}`);
    const call = seen[0];
    is(call?.auth === "Bearer tok-home", `the hook sent ${JSON.stringify(call?.auth)}, not the token the helper resolves`);
    is(call?.client === "zz-hook", "the hook does not say it is the hook");
    is(/"name":"skill_read","arguments":\{"name":"zz-platform"\}/.test(call?.body ?? ""), "the hook did not report zz-platform as skill_read");
  } finally {
    core.close();
  }

  // 5. The install's node line, which writes what the helper reads on a machine with no bash
  is(typeof tokenWriteCommand === "string" && tokenWriteCommand.startsWith('node -e "'), "there is no node line that writes the token file");
  const line = String(tokenWriteCommand ?? "");
  // PowerShell expands $ and ` inside double quotes, cmd expands %, interactive bash expands !.
  is(!/[$`%!]/.test(line), `the token line holds a character a shell rewrites: ${line}`);
  is(line.split('"').length === 3, "the token line quotes more than its one script");
  const writer = join(dir, "writer");
  const writes = async (env: Record<string, string>) =>
    run("sh", ["-c", line], { env: { PATH: process.env.PATH ?? "", HOME: writer, ...env }, timeout: 10_000 })
      .then(() => true, () => false);
  is(!(await writes({})) && !existsSync(join(writer, ".zz/token")), "the token line wrote a file with no ZZ_TOKEN set");
  is(await writes({ ZZ_TOKEN: "tok-written" }), "the token line failed with ZZ_TOKEN set");
  const written = join(writer, ".zz/token");
  is(existsSync(written) && readFileSync(written, "utf8") === "tok-written", "the token line did not write ZZ_TOKEN to ~/.zz/token");
  is(existsSync(written) && (statSync(written).mode & 0o777) === 0o600, "the token file is not owner-only (600)");
  is(existsSync(written) && (statSync(join(writer, ".zz")).mode & 0o777) === 0o700, "~/.zz is not owner-only (700)");
  if (existsSync(written)) {
    chmodSync(written, 0o644);
    chmodSync(join(writer, ".zz"), 0o755);
  }
  is(await writes({ ZZ_TOKEN: "tok-again" }), "the token line failed over an earlier install");
  is(existsSync(written) && (statSync(written).mode & 0o777) === 0o600 && (statSync(join(writer, ".zz")).mode & 0o777) === 0o700,
     "a looser token file or ~/.zz from an earlier install stays loose");
  is(bearer(await headers({ HOME: writer })) === "Bearer tok-again", "the helper does not read the file the token line wrote");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (fail.length) {
  for (const f of fail) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("PASS the headers helper and the skill-report hook run through node, and resolve the token as they always have");
