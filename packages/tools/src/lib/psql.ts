/**
 * Running one query against the platform database, written once. Every tool that reads this
 * database goes through here, so the deployment's compose service, user and database are named in
 * one place.
 *
 * DELIBERATE: through psql variables and stdin, never interpolated into the statement. psql
 * performs variable interpolation while lexing its input, so a statement handed to -c never goes
 * through that pass and `:'name'` arrives at the server literally.
 *
 * DELIBERATE: not through a shell. splitCommand turns the configured command into an argv,
 * because these command lines carry a database name beside an operator's own arguments.
 */
import { execFileSync } from "node:child_process";

import { die } from "./cli.js";
import { splitCommand } from "./shell.js";

/** The deployment's own database, reached the way backup.sh and issue-first-pat.sh reach it.
 * Every tool takes `--psql` to override it for anywhere else. */
export const DEFAULT_PSQL = "docker compose exec -T postgres psql -U zz -d zz";

/** How much of an answer we are willing to hold in memory.
 *
 * DELIBERATE: not a tuning knob. execFileSync defaults to 1MB and truncates silently past it —
 * the child is killed, the partial output is returned, and the only symptom is that the JSON no
 * longer parses, which psqlRows then blames on the operator's command. 256MB is larger than any
 * answer this schema can produce for a single window. */
const MAX_OUTPUT = 256 * 1024 * 1024;

/** One query, as raw `-tA` text. `vars` become psql `-v name=value` bindings. */
export function psqlText(psql: string, sql: string, vars: Record<string, string> = {}): string {
  const [cmd, ...rest] = splitCommand(psql);
  const argv = [...rest, "-tA"];
  for (const [k, v] of Object.entries(vars)) argv.push("-v", `${k}=${v}`);
  try {
    return execFileSync(cmd, argv,
      { input: sql, encoding: "utf8", maxBuffer: MAX_OUTPUT, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    return die(`psql failed: ${(e.stderr || e.stdout || e.message || "").trim().slice(-400)}`);
  }
}

/**
 * One statement, where failing is a result rather than the end of the run.
 *
 * psqlText die()s, which is right for every tool that reads this database. A check is the one
 * caller that wants the opposite: it runs statements expecting some to be refused and has to
 * report all of them rather than the first — sql-check PREPAREs every one of this repository's
 * queries against a real schema.
 *
 * Here and not in a transport of its own: the argv rule this file holds — stdin and `-v`
 * bindings, never `-c` — is the same rule whether the caller can survive a failure or not.
 */
export function psqlTry(psql: string, sql: string, vars: Record<string, string> = {}):
    { ok: true; text: string } | { ok: false; error: string } {
  const [cmd, ...rest] = splitCommand(psql);
  // ON_ERROR_STOP so a refused statement is a non-zero exit and lands in catch, rather than psql
  // printing the error to stderr, continuing, and exiting 0 — which would read here as a
  // statement that passed.
  const argv = [...rest, "-tA", "-v", "ON_ERROR_STOP=1"];
  for (const [k, v] of Object.entries(vars)) argv.push("-v", `${k}=${v}`);
  try {
    return { ok: true,
             text: execFileSync(cmd, argv,
                                { input: sql, encoding: "utf8", maxBuffer: MAX_OUTPUT,
                                  stdio: ["pipe", "pipe", "pipe"] }).trim() };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    return { ok: false, error: (e.stderr || e.stdout || e.message || "").trim() };
  }
}

/**
 * One SELECT, as rows. Give it the select; the json_agg is this function's.
 *
 * The wrapper is the invariant, so it is composed here rather than by each caller: a select
 * written without it comes back as `-tA` tab-separated text, falls through to the refusal below,
 * and blames the operator's `--psql` command for the tool's own SQL.
 *
 * `coalesce(…, '[]')` is what makes an empty result an empty list rather than an empty string,
 * which is what lets the empty case below be a fact rather than a guess.
 *
 * What came back is not always JSON. psqlText turns a command that fails into a sentence; a
 * command that succeeds and prints something else — a wrapper printing a banner, or something
 * that is not psql — would otherwise reach JSON.parse and come out as a SyntaxError with a
 * stack. */
export function psqlRows<T>(psql: string, select: string, vars: Record<string, string> = {}): T[] {
  const sql = `select coalesce(json_agg(row_to_json(t)), '[]') from (\n${select}\n) t;`;
  const body = psqlText(psql, sql, vars);
  if (!body) return [];
  try {
    return JSON.parse(body) as T[];
  } catch {
    return die(
      `that psql command answered with something that is not JSON:\n  ${body.slice(0, 200)}\n` +
        `  ran: ${psql}\n` +
        "  every query here is wrapped in a single json_agg by this function, so anything " +
        "else means the command is not psql, printed something before the result, or was " +
        `cut off — this holds up to ${Math.round(MAX_OUTPUT / 1024 / 1024)}MB and answers ` +
        "larger than that arrive truncated, which looks exactly like malformed JSON.",
    );
  }
}
