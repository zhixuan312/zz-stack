/**
 * Measure a building block against the published standard, from its tool surface alone.
 *
 * Read-only against a live gateway with your own token — and reports the requirements that a
 * tool surface can actually settle.
 *
 *   npm run conformance -- --gateway https://api.<host> --block RuleMill
 *   npm run conformance -- --gateway https://api.<host> --block all --json
 *
 * NOT every requirement is checkable this way, and the report says so rather than scoring
 * what it did not test. R7 (lifecycle enforced server-side), R12 (caller identity honoured),
 * R13 (staging affordances) and R14 (full nested webhook payloads) are behavioural: they need
 * a write, a sequence, or a delivered event, and a battery that guessed at them from tool
 * names would hand out passes the contract never granted. R1 is an architectural fact about
 * deployment, not a property of one server's surface.
 */
import { Mcp, McpError, type RpcEnvelope, type ToolInfo } from "@zz/mcp-client";

import { die, envRequired, parseArgs, required } from "../lib/cli.js";
import { teachesTheRule } from "../lib/refusal.js";

/** Requirements a TOOL SURFACE cannot settle. Reported as unmeasured, never scored. */
const NOT_MEASURED: Record<string, string> = {
  R1: "one server per block — a deployment fact, not a surface property",
  R7: "lifecycle enforced server-side — needs a write and a refusal",
  R12: "caller identity honoured — needs two callers to compare",
  R13: "staging affordances — needs a test write and its restore",
  R14: "full nested webhook payloads — needs a delivered event",
};

/** Verbs the contract names as the wrong kind (R5): they say that something was done rather
 * than which capability was exercised, so an agent cannot tell when to reach for the tool. */
const VAGUE = /^(do_|perform_|handle_|process_|submit$|execute$|action$|run$)/;

interface Requirement {
  met: boolean | null;
  what: string;
  detail: string;
}
interface Report {
  block: string;
  reachable: boolean;
  why?: string;
  tools?: number;
  requirements?: Record<string, Requirement>;
  not_measured?: Record<string, string>;
}

const SESSIONS = new Map<string, Mcp>();

/**
 * One MCP call, returning the JSON-RPC envelope.
 *
 * The envelope rather than the text, because this engine asks whether a call ERRORED as
 * often as it asks what it said — `error` in the envelope is one of the things being
 * measured, not an exception to escape from.
 *
 * Sessions are kept per endpoint. Measuring one block asks it several questions, and opening
 * a session for each made one measurement look like several clients to the block being
 * measured — which is a poor way to behave toward somebody else's service.
 */
async function mcp(gateway: string, path: string, pat: string, method: string, params?: unknown): Promise<RpcEnvelope> {
  const key = `${gateway}\u0000${path}`;
  if (!SESSIONS.has(key)) {
    SESSIONS.set(key, new Mcp(`${gateway.replace(/\/+$/, "")}/${path}`, { pat, client: "conformance" }));
  }
  try {
    return await SESSIONS.get(key)!.rpc(method, params);
  } catch (e) {
    if (!(e instanceof McpError)) throw e;
    // Shaped like a JSON-RPC error so every caller keeps its one way of reading failure.
    return { error: { message: e.message } };
  }
}

/** True when a description says no more than the tool's own name already did. */
function echoesName(name: string, description: string): boolean {
  const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const fromName = new Set(words(name));
  const fromDesc = words(description);
  if (fromDesc.length === 0) return true;
  // Anything the name did not already contain is information. Two such words is a sentence;
  // none is an echo however it is punctuated.
  return fromDesc.filter((w) => !fromName.has(w)).length < 2;
}

function resultText(env: RpcEnvelope): string {
  if (env.error) return `RPC ERROR: ${env.error.message ?? ""}`;
  return (env.result?.content ?? []).map((c) => c.text ?? "").join(" ");
}

async function measure(gateway: string, block: string, pat: string): Promise<Report> {
  const env = await mcp(gateway, `p/${block}/mcp`, pat, "tools/list");
  if (env.error) return { block, reachable: false, why: env.error.message ?? "unknown" };
  const tools: ToolInfo[] = env.result?.tools ?? [];
  const names = new Set(tools.map((t) => t.name));
  const described = new Map(tools.map((t) => [t.name, (t.description ?? "").trim()]));

  // A block with no stored credential answers with ONE tool that says so. Scoring that as
  // thirteen failures would blame the block for the caller's missing key.
  if (tools.length <= 1) {
    return {
      block,
      reachable: true,
      tools: tools.length,
      why: "one tool only — this caller has stored no key for this block, so there is no surface to measure",
      requirements: {},
    };
  }

  const has = (...cands: string[]): string | null => cands.find((c) => names.has(c)) ?? null;
  const matching = (rx: RegExp): string[] => [...names].filter((n) => rx.test(n)).sort();

  // A requirement names ONE verb, and a block that does the same job under another name has
  // not met the standard as written — but "absent" would be a false picture. §6 of the
  // contract already says this about R9 and a `generate_*` verb where the standard asks for `get_*`: either the
  // requirement names the wrong verb or three implementations are wrong, and that is a
  // decision for the next revision. Reporting what was found instead is what lets anyone
  // make it.
  const near = (absent: string, rx: RegExp): string => {
    const found = matching(rx);
    return found.length ? `${absent} — found ${found.join(", ")}` : absent;
  };

  const creates = matching(/^create_/);
  const unbacked = creates.filter((c) => ![...names].some((n) => n.startsWith(`get_${c.slice(7)}`)));
  const vague = [...names].filter((n) => VAGUE.test(n)).sort();
  // A description that only restates the name teaches an agent nothing about WHEN to reach
  // for the tool, which is the decision it is actually making. A block can have every tool
  // described and still teach nothing, because a description can restate the tool's own name
  // and count as present — `read_user_guide` described as "Read user guide". A length floor
  // calls the shortest of those a gap and lets the rest through; an echo test names the whole
  // class.
  const undocumented = [...described].filter(([n, d]) => echoesName(n, d)).map(([n]) => n).sort();
  const catalogue = matching(/^list_(node_types|connectors|integrations|.*_types)$/);

  const req: Record<string, Requirement> = {
    R2: {
      met: Boolean(has("get_platform_overview")),
      what: "self-description a business user recognises",
      detail: has("get_platform_overview") ?? near("no get_platform_overview", /overview|user_guide|about/),
    },
    R3: {
      met: Boolean(has("read_api_spec")),
      what: "docs tool covering the rules the API enforces",
      detail: has("read_api_spec") ?? "no read_api_spec",
    },
    R4: {
      met: Boolean(has("list_usage_skills") && has("usage_skill_view")),
      what: "usage skills served by the server",
      detail:
        ["list_usage_skills", "usage_skill_view"].filter((n) => names.has(n)).sort().join(", ") ||
        "neither list_usage_skills nor usage_skill_view",
    },
    R5: {
      met: vague.length === 0 && undocumented.length === 0,
      what: "honest tool verbs that state the capability",
      detail:
        (vague.length ? `vague: ${vague.join(", ")}` : "") +
          (vague.length && undocumented.length ? "; " : "") +
          (undocumented.length ? `undescribed: ${undocumented.join(", ")}` : "") ||
        `${tools.length} tools, all named for a capability and described`,
    },
    R8: {
      // NULL, not false. The detail already said a tool surface cannot tell a missing
      // catalogue from a block that has no connector surface to catalogue — and then scored
      // it as unmet anyway, which is the guessing this engine's first paragraph refuses.
      // `met === null` is the marker it already uses for exactly this, and the exit code
      // excludes it.
      met: catalogue.length > 0 ? true : null,
      what: "a catalogue of the connector surface, where there is one",
      detail:
        catalogue.join(", ") ||
        "no catalogue tool — and a tool surface cannot tell that from a block with no connector surface",
    },
    R9: {
      met: Boolean(has("get_app_url")),
      what: "a web view for every stateful object",
      detail: has("get_app_url") ?? near("no get_app_url", /_url$|^get_url/),
    },
    R10: {
      // A block with no create_* tools scored UNMET for "read-back for every write", which
      // penalises a read-only surface for having no writes — and cannot distinguish that from
      // a block whose writes are spelled add_* or new_*. Nothing to read back is not a failure
      // to read back.
      met: creates.length === 0 ? null : unbacked.length === 0,
      what: "read-back for every write",
      detail: unbacked.length
        ? `create without a get_*: ${unbacked.join(", ")}`
        : creates.length
          ? `${creates.length} create_* tools, each with a get_*`
          : "no create_* tools — nothing to read back, and a surface cannot tell that from writes named otherwise",
    },
    R11: {
      met: matching(/audit/).length > 0,
      what: "platform-level and per-record audit trails",
      detail: matching(/audit/).join(", ") || "no audit tool",
    },
  };

  // R6 is behavioural but cheap and read-only: call ONE tool the wrong way and read what
  // comes back. The contract asks for prose that teaches the rule, not a bare status.
  //
  // One tool is a sample, not a verdict, and this check has already been caught by that.
  // A block can pass here — the probe lands on a documentation tool, which answers properly —
  // while a write tool on the same block refuses most calls with a bare status and nothing
  // else, so the agent retries the same arguments until it gives up. The honest measure of R6
  // is the deployment's own refusal record: tool-report counts refusals that taught the caller
  // nothing. This says whether the block CAN teach; that says whether it does.
  //
  // READ-ONLY tools only, and no fallback to "whatever sorts first". That fallback would have
  // called a block's alphabetically-first tool with a junk argument — something like `add_key`
  // or `delete_record`. Validation would probably have refused it, and "probably" is not a
  // basis for firing a write at a system you do not own in order to measure its error
  // messages. A block with no read-only tool to ask simply does not get an R6 verdict here.
  //
  // The prefix regex below is a GUESS about a name, and this fires a live call at a server
  // this project does not own. A name like `archive_thread` passes a read-only prefix rule and
  // is not read-only. So ask the server first:
  // MCP lets a tool declare `annotations.readOnlyHint`, which is the block's own statement
  // about its own tool rather than our inference from its spelling. The prefix rule stays as
  // the fallback for a block that annotates nothing, and the verdict says which of the two
  // picked the probe, so a reader can tell a declared fact from a guess.
  const declared = tools
    .filter((t) => (t as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint === true)
    .map((t) => t.name)
    .sort();
  const named = ["read_api_spec", "get_platform_overview", "read_user_guide"].find((n) => names.has(n)) ?? null;
  let basis = "declared readOnlyHint";
  let safe: string | null = named !== null && declared.includes(named) ? named : (declared[0] ?? null);
  if (!safe) {
    basis = "name prefix, not declared — the block annotates no tool read-only";
    safe = named ?? [...names].sort().find((n) => /^(get|list|read|search)_/.test(n)) ?? null;
  }
  if (!safe) {
    req.R6 = {
      met: null,
      what: "validation errors in prose that teach the rule",
      detail: "not measured — no read-only tool to ask, and a write is not an acceptable probe",
    };
    return { block, reachable: true, tools: tools.length, requirements: req, not_measured: NOT_MEASURED };
  }

  const probe = resultText(
    await mcp(gateway, `p/${block}/mcp`, pat, "tools/call", {
      name: safe,
      arguments: { __conformance_probe__: "not a real argument" },
    }),
  );
  // The same judgement tool-report applies, not a length floor of its own. This one asked
  // whether the answer was longer than forty characters and did not know about `request
  // failed with status code`, so "RPC ERROR: request failed with status code 422" — forty-six
  // characters, and the exact string this file's comment above quotes as what R6 exists to
  // catch — scored R6 as MET. It is also the commonest shape here, because `RPC ERROR: ` is
  // the prefix resultText adds to every JSON-RPC error itself.
  const teaches = teachesTheRule(probe);
  req.R6 = {
    met: teaches,
    what:
      `validation errors in prose that teach the rule (ONE tool sampled, ${safe} by ${basis} — ` +
      "tool-report counts the ones that actually taught nothing)",
    detail: probe.trim().slice(0, 200) || "empty answer to an invalid call",
  };

  return { block, reachable: true, tools: tools.length, requirements: req, not_measured: NOT_MEASURED };
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, ["json"]);
  const gateway = required(args, "gateway", "e.g. https://api.<host>");
  const block = required(args, "block", "a block id, or 'all'");
  // Read from the environment and not from an argument: an argument is in `ps` for every
  // user on the host and in shell history afterwards.
  const pat = envRequired("ZZ_PAT", "your platform token");

  let blocks: string[];
  if (block === "all") {
    const listed = resultText(
      await mcp(gateway, "manage/mcp", pat, "tools/call", { name: "list_platforms", arguments: {} }),
    );
    // The answer is prose when the call failed, and JSON.parse on it ended the run in a stack
    // trace with the actual reason — "RPC ERROR: …" — thrown away inside the exception.
    try {
      blocks = Object.keys(JSON.parse(listed) as Record<string, unknown>).sort();
    } catch {
      die(`could not list the blocks from ${gateway}/manage/mcp: ${listed.trim().slice(0, 300)}`);
    }
  } else {
    blocks = [block];
  }

  const reports: Report[] = [];
  for (const b of blocks) reports.push(await measure(gateway, b, pat));

  // A ✗ is a failure, and this used to print one and exit 0. Anything running this in a
  // release or a pipeline read that as a pass, which is the same defect manifest-audit
  // records having had — it printed FAIL and returned success.
  //
  // NOT-MEASURED is not a failure. R1, R7, R12, R13 and R14 need a write, a sequence or a
  // delivered event, and the whole design of this engine is that it says so rather than
  // guessing. Counting them would make every block fail forever and the exit code useless a
  // second way. `met === null` is the unmeasured marker and it is excluded here.
  let unmet = 0;
  // A block this caller holds no key for answers with one tool that says so, and NOTHING about
  // it was measured. That produced zero unmet requirements and exit 0 — so `--block all` run by
  // somebody with no keys reported every block conformant, which is the one answer a
  // conformance run must never give by accident. Exit 2 is already this repository's "could
  // not tell", and it is what that case gets.
  const unmeasurable = reports.filter(
    (r) => r.reachable && Object.keys(r.requirements ?? {}).length === 0).map((r) => r.block);
  for (const r of reports) {
    if (!r.reachable) {
      unmet++;
      continue;
    }
    for (const v of Object.values(r.requirements ?? {})) if (v.met === false) unmet++;
  }
  const status = (): number => (unmet ? 1 : unmeasurable.length ? 2 : 0);

  if (args.flags.has("json")) {
    console.log(JSON.stringify(reports, null, 2));
    return status();
  }

  for (const r of reports) {
    console.log(`\n── ${r.block} ${"─".repeat(Math.max(0, 60 - r.block.length))}`);
    if (!r.reachable) {
      console.log(`   unreachable: ${r.why}`);
      continue;
    }
    if (!r.requirements || Object.keys(r.requirements).length === 0) {
      console.log(`   ${r.why}`);
      continue;
    }
    console.log(`   ${r.tools} tools\n`);
    const order = (k: string): number => Number(k.slice(1));
    for (const [name, v] of Object.entries(r.requirements).sort((a, b) => order(a[0]) - order(b[0]))) {
      console.log(`   ${v.met === null ? "?" : v.met ? "✓" : "✗"} ${name}  ${v.what}`);
      console.log(`        ${v.detail}`);
    }
    console.log("\n   not measured here:");
    for (const [name, why] of Object.entries(r.not_measured ?? {}).sort((a, b) => order(a[0]) - order(b[0]))) {
      console.log(`     ${name}  ${why}`);
    }
  }
  console.log();
  if (unmet) console.log(`   ${unmet} unmet or unreachable across ${reports.length} block(s)\n`);
  if (unmeasurable.length) {
    console.log(`   NOT MEASURED AT ALL: ${unmeasurable.join(", ")} — store a key for each and
` +
                "   run this again. Nothing above says whether they conform.\n");
  }
  return status();
}

process.exit(await main(process.argv.slice(2)));
