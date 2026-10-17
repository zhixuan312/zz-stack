/**
 * The console's five reads on the core door, walked against a live deployment: platform_status,
 * release_list, activity_refusals, run_summary and record_read.
 *
 * Separate from chain-check.ts by subject: that file is the document chain, these are reads that
 * change nothing, whose figures depend on what the deployment holds. So what is asserted is what
 * holds whatever it holds: each answer is its page's object under its page's keys, its structured
 * content is its JSON text, and an argument outside the read's vocabulary is refused by the
 * read's own sentence.
 *
 * COUPLED: `checks/chain-check-wiring.ts` follows this import, so a tool exercised here counts
 * as exercised.
 */

/** The pieces chain-check owns: its live client and its two recorders. Handed in rather than
 *  re-made, so this walks the same door, as the same token, into the same result set. Not
 *  exported — it names this function's own parameter and nothing else constructs one. */
interface ReadsDeps {
  call: (tool: string, args: unknown) => Promise<string>;
  /** The /core client itself, for the one thing `call` drops: the answer's structured content. */
  core: { rpc: (method: string, params?: unknown) => Promise<{ result?: unknown; error?: unknown }> };
  check: (name: string, got: string, wantError: boolean, because?: RegExp) => void;
  record: (ok: boolean, name: string, got: string) => void;
}

type Obj = Record<string, unknown>;

/** The answer as an object, or null when it is anything else, a refusal included. */
function objectOf(got: string): Obj | null {
  try {
    const v: unknown = JSON.parse(got);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Obj : null;
  } catch {
    return null;
  }
}

/** A part's rows, when the part was read: `{ state: "ok", data }`, else null. */
const okData = (part: unknown): unknown =>
  (part as { state?: string; data?: unknown } | undefined)?.state === "ok" ? (part as { data: unknown }).data : null;

export async function walkReads({ call, core, check, record }: ReadsDeps): Promise<void> {
  /** The page's keys, all present: the one claim about an answer's shape that holds on any data. */
  const answers = (tool: string, got: string, keys: string[]): Obj | null => {
    const obj = objectOf(got);
    record(obj !== null && keys.every((k) => k in obj), `${tool} answers its page's ${keys.join(", ")}`, got);
    return obj;
  };

  /** Both halves of one answer. `call` joins the text parts and drops the rest, so this asks the
   *  client for the envelope: the text a client shows must be the object another client reads. */
  const bothHalves = async (tool: string, args: Obj): Promise<void> => {
    const env = await core.rpc("tools/call", { name: tool, arguments: args });
    const result = env.result as { structuredContent?: unknown; content?: { text?: string }[] } | undefined;
    const text = (result?.content ?? []).map((c) => c?.text ?? "").filter(Boolean).join("\n");
    record(!env.error && result?.structuredContent !== undefined && JSON.stringify(result.structuredContent) === text,
      `${tool}'s structured content is its JSON text`, env.error ? JSON.stringify(env.error) : text);
  };

  // platform_status is a member's as much as a superadmin's, and each door's day-by-day array is
  // the half the tool says it leaves out.
  const status = answers("platform_status",
    await call("platform_status", {}), ["meta", "needs", "measures", "records", "doors", "running", "own"]);
  const doors = okData(status?.doors);
  if (Array.isArray(doors)) {
    record(doors.every((d) => !("days" in (d as Obj))), "platform_status leaves out each door's days",
      JSON.stringify(doors).slice(0, 200));
  }
  await bothHalves("platform_status", {});
  check("platform_status refuses a tool no door registers, by its own sentence",
    await call("platform_status", { tool: "chain_check_no_such_tool" }), true, /tool must name a tool/);

  const releases = answers("release_list",
    await call("release_list", { limit: 1 }), ["meta", "tiles", "weeks", "rows"]);
  const page = okData(releases?.rows) as { rows?: unknown[] } | null;
  if (page) record(Array.isArray(page.rows) && page.rows.length <= 1, "release_list answers no more than its limit",
    JSON.stringify(page).slice(0, 200));
  // DELIBERATE: a version no release could carry, so the refusal is the read's and never the
  // window it would otherwise answer: an unknown version is refused, never read as every release.
  check("release_list refuses a version no release records",
    await call("release_list", { since: "0.0.0-chain-check" }), true, /since names no recorded release/);

  // The three Work reads are the active team's. A token acting for none is refused by name, which
  // is a fact about the token rather than a defect, and nothing about the shape is measured. Its
  // refusals below are then that sentence too: the team is asked before any argument is.
  //
  // COUPLED: the two sentences are the gateway's NO_TEAM, Activity's and the Work pages' own.
  const NO_TEAM = /^ERROR: (?:no team:|you act for no team)/;
  let teamless = false;
  const byTheRead = (sentence: RegExp): RegExp => (teamless ? NO_TEAM : sentence);
  const work = async (tool: string, args: Obj, keys: string[]): Promise<Obj | null> => {
    const got = await call(tool, args);
    if (NO_TEAM.test(got.trim())) {
      console.log(`  skip  ${tool} is the active team's and this token acts for none — nothing measured`);
      teamless = true;
      return null;
    }
    const obj = answers(tool, got, keys);
    await bothHalves(tool, args);
    return obj;
  };

  const activity = await work("activity_refusals", {},
    ["meta", "tiles", "weeks", "groups", "maintenance", "byTool", "messages"]);
  const messages = okData(activity?.messages);
  if (Array.isArray(messages)) record(messages.length <= 10, "activity_refusals answers at most ten messages",
    JSON.stringify(messages).slice(0, 200));
  // A string, never a number: a value of the wrong type is the schema's refusal, not the read's,
  // and `because` would then pass on a sentence this read never wrote.
  check("activity_refusals refuses a since that is not a date",
    await call("activity_refusals", { since: "not-a-date" }), true, byTheRead(/since must be a date/));

  await work("run_summary", {}, ["meta", "since", "tiles", "coverage", "bySkill", "recent"]);
  check("run_summary refuses a since that is not a date",
    await call("run_summary", { since: "not-a-date" }), true, byTheRead(/since must be a date/));

  const rec = await work("record_read", { period: "quarter" },
    ["meta", "period", "lead", "cumulative", "foot", "work", "documents", "knowledge", "agents", "firsts", "record"]);
  if (rec) record(rec.period === "quarter", "record_read answers the period it was asked for", JSON.stringify(rec.period));
  check("record_read refuses a period outside its vocabulary",
    await call("record_read", { period: "decade" }), true, byTheRead(/period must be one of/));
}
