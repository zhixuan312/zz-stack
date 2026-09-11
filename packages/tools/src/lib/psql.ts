/**
 * Running one query against the platform database, written once.
 *
 * Five tools each carried this: collect-turns, watch-results, evolve-report, flow-compare and
 * tool-report. `q<T>` in watch-results and `query<T>` in flow-compare were byte-identical
 * apart from the name; evolve-report's `events()` was the same function with its SQL and its
 * one variable inlined; and all five spelled out the same default psql command, so the
 * deployment's compose service, user and database were recorded in five places at once.
 *
 * THROUGH psql VARIABLES AND STDIN, never interpolated into the statement. psql performs
 * variable interpolation while LEXING its input, so a statement handed to -c never goes
 * through that pass and `:'name'` arrives at the server literally — deploy/issue-first-pat.sh
 * learned both halves of that the hard way, and reset-smoke-store.sh repeats the warning.
 *
 * NOT through a shell. splitCommand turns the configured command into an argv, because these
 * command lines carry a database name beside an operator's own arguments.
 */
import { execFileSync } from "node:child_process";

import { die } from "./cli.js";
import { splitCommand } from "./shell.js";

/** The deployment's own database, reached the way backup.sh and issue-first-pat.sh reach it.
 * Every tool takes `--psql` to override it for anywhere else. */
export const DEFAULT_PSQL = "docker compose exec -T postgres psql -U zz -d zz";

/** How much of an answer we are willing to hold in memory.
 *
 * NOT A TUNING KNOB — a correctness fix. execFileSync defaults to 1MB and TRUNCATES silently
 * past it: the child is killed, the partial output is returned, and the only symptom is that
 * the JSON no longer parses. psqlRows then blamed the command, telling an operator "that psql
 * command answered with something that is not JSON... anything else means the command is not
 * psql", which is a confident accusation against the one thing that was working.
 *
 * Three days of one campaign is 1,157,750 bytes — every tool that reads this database broke at
 * exactly the volume the platform is for. 256MB is chosen to be larger than any answer this
 * schema can produce for a single window, not to be a limit anybody tunes. */
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
 * One statement, where FAILING is a result rather than the end of the run.
 *
 * psqlText die()s, which is right for every tool that reads this database: an operator whose
 * query failed wants a sentence and no stack, and there is nothing sensible to do next. A
 * CHECK is the one caller that wants the opposite — it runs a statement expecting some to be
 * refused, and has to report all of them rather than the first. sql-check PREPAREs all 74 of
 * this repository's queries against a real schema, so dying on the first would hide the rest.
 *
 * Here and not in a second transport of its own. The argv rule this file exists to hold —
 * STDIN and `-v` bindings, never `-c`, because psql interpolates while lexing — is the same
 * rule whether the caller can survive a failure or not, and the last time it lived in more
 * than one place it lived in five.
 */
export function psqlTry(psql: string, sql: string, vars: Record<string, string> = {}):
    { ok: true; text: string } | { ok: false; error: string } {
  const [cmd, ...rest] = splitCommand(psql);
  // ON_ERROR_STOP so a refused statement is a non-zero exit and lands in catch, rather than
  // psql printing the error to stderr, continuing, and exiting 0 — which would read here as
  // a statement that passed.
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
 * THE WRAPPER IS THE INVARIANT, and it used to be stated here and hand-written by every
 * caller. Seven call sites each opened with `select coalesce(json_agg(row_to_json(t)), '[]')
 * from (` and closed with `) t;`, while the refusal below said "every query here selects a
 * single json_agg" as though something guaranteed it. Nothing did — and a caller who wrote
 * the select without it got `-tA` tab-separated text, which fell through to that refusal and
 * blamed the OPERATOR's `--psql` command for the tool's own SQL. A message that names the
 * wrong half is worse than none.
 *
 * `coalesce(…, '[]')` is also what makes an empty result an empty list rather than an empty
 * string, so composing it here is what lets the empty case below be a fact rather than a
 * guess.
 *
 * WHAT CAME BACK IS NOT ALWAYS JSON, and this parsed it as if it were. psqlText already turns
 * a command that FAILS into a sentence; a command that succeeds and prints something else went
 * straight into JSON.parse and out as a SyntaxError with a stack — which is what happens when
 * `--psql` names a wrapper that prints a banner, or names something that is not psql at all.
 * The reader is an operator who mistyped a command, and cli.ts's whole first paragraph is
 * about not showing them a stack trace. */
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
