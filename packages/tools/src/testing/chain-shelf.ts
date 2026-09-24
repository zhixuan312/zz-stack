/**
 * The shelf, walked against a live deployment: which skills a caller can reach, the knowledge
 * store's subject vocabulary and supersession, and the evaluation door's own refusals.
 *
 * chain-check.ts holds the document chain — write, gate, approve, close, and the refusals that
 * hold the sequence together. What a caller may read and what the platform already knows are
 * asked of different doors and live here.
 *
 * COUPLED: `checks/chain-check-wiring.ts` follows this import, so a tool exercised here counts
 * as exercised.
 */

/** The pieces chain-check owns: its live client and its recorders. Handed in rather than
 *  re-made, so this walks the same door, against the same initiative, into the same result set. */
interface ShelfDeps {
  call: (tool: string, args: unknown) => Promise<string>;
  check: (name: string, got: string, wantError: boolean, because?: RegExp) => void;
  record: (ok: boolean, name: string, got: string) => void;
  /** For the tools that degrade with a named refusal when a deployment has no platform
   *  database: a refusal that says which one is an answer, not a failure. */
  eitherOr: (name: string, got: string, acceptableRefusal: RegExp) => void;
  INIT: string;
}

export async function walkShelf({ call, check, record, eitherOr, INIT }: ShelfDeps): Promise<void> {
  // skill_list and skill_read degrade (a named ERROR) rather than fail outright when this
  // deployment has no platform database — session_whoami's own team lookup already treats that
  // as ordinary above, and these two tools document the identical fallback.
  eitherOr("skill_list lists what this caller can reach",
    await call("skill_list", {}), /platform database is unreachable/);
  // zz-platform ships with the `zz-core` plugin, which every account carries — session_whoami points
  // here itself ("skill_read(\"zz-platform\")"), so this is the one skill name the door can
  // promise exists without reading this deployment's own catalog first.
  check("skill_read reads the platform's own spine skill",
    await call("skill_read", { name: "zz-platform" }), false);
  // Asserted on the half that has a right answer whatever this deployment holds: which owners
  // exist depends on which flows are installed, so the shelf is checked for shape above, while
  // an owner id nothing answers to must be refused by name, listing the ones that do.
  check("skill_list refuses an owner no plugin answers to",
    await call("skill_list", { owner: "no-such-owner-chain-check" }), true,
    /is not a plugin you can reach/);

  // A subject tag says what kind of thing a piece of knowledge is about, and the kinds are a
  // closed set. Open, it becomes a free-text field that agrees with nothing.
  //
  // Every other argument has to be valid, or a call refused by the schema is read as the rule
  // firing and the check passes without reaching it. Three things make this fixture reach
  // subjectTagError: `evidence` names an initiative folder, one plain segment, that exists in
  // a store this caller belongs to; `scope` is given, because knowledge_add's schema refuses a
  // call that omits it; and the positive control below shares the fixture.
  const node = {
    title: "chain-check subject probe",
    type: "knowledge",
    body: "written by chain-check; safe to supersede.",
    evidence: [INIT],
    scope: "team" as const,
  };
  check("a knowledge subject must be a kind the platform knows",
    await call("knowledge_add", { ...node, tags: ["nonesuch:casebox"] }), true, /is not a kind/);
  const added = await call("knowledge_add", { ...node, tags: ["plugin:zz-core"] });
  check("a known kind is accepted", added, false);

  // knowledge_supersede needs two nodes that exist, on the same shelf. The id is read back out
  // of the tool's own reply, because a fixture id increments differently on every store.
  const oldId = /journal node (\d+) created/.exec(added)?.[1];
  if (oldId) {
    const superseding = await call("knowledge_add",
      { ...node, title: "chain-check subject probe (superseding)", tags: ["plugin:zz-core"] });
    const newId = /journal node (\d+) created/.exec(superseding)?.[1];
    if (newId) {
      // Naming the shelf, because both shelves allocate from 0001 and a bare id can mean a node
      // on each. The fixture above is minted with `scope: "team"`, so that is the shelf these
      // two ids are on.
      check("knowledge_supersede marks a node superseded by one that exists",
        await call("knowledge_supersede", { old_id: oldId, new_id: newId, shelf: node.scope }), false);
    } else {
      record(false, "knowledge_supersede marks a node superseded by one that exists",
        `could not mint a second node to supersede with: ${superseding}`);
    }
  } else {
    record(false, "knowledge_supersede marks a node superseded by one that exists",
      `could not read an id back from knowledge_add: ${added}`);
  }

  // knowledge_search refuses the same way session_whoami's team lookup does — no platform
  // database, or no team — which is ordinary on a deployment run without either.
  eitherOr("knowledge_search finds the node this run just wrote",
    await call("knowledge_search", { query: "chain-check subject probe" }),
    /no platform database|no platform db|not in a team/);

  /* The AND pass finds nothing, so the OR pass runs, and the answer says it did.
   *
   * `websearch_to_tsquery` joins unquoted terms with AND, so a long question demands one
   * document containing every word. The query below is empty under AND by construction — the
   * last token appears in no document anywhere — while every other word is in the probe node
   * this walk just wrote.
   *
   * Both halves of the broadened pass's contract are asserted: the note telling a reader these
   * match only some of the terms, and `via: ["lexical-broad"]` on the rows. Asserting only that
   * something came back would pass on a plain match.
   *
   * Refusals are tolerated as above: a deployment with no platform database or no team is
   * ordinary.
   */
  const broadened = await call("knowledge_search",
    { query: "chain-check subject probe zqxwvnotokeninanydocument" });
  const refusedLegitimately = /^(ERROR|REFUSED):/i.test(broadened.trim())
    && /no platform database|no platform db|not in a team/.test(broadened);
  record(refusedLegitimately
         || (/No document contains all of those terms together/.test(broadened)
             && /"lexical-broad"/.test(broadened)),
         "a question no single document answers is broadened, and the answer says so",
         broadened);
}
