/**
 * The shelf, walked against a live deployment: which skills a caller can reach, the knowledge
 * store's subject vocabulary and supersession, and the evaluation door's own refusals.
 *
 * SPLIT OUT OF chain-check.ts BY SUBJECT, the way chain-bugs.ts was. That file is about the
 * document chain — write, gate, approve, close, and the refusals that hold the sequence
 * together. What a caller may READ and what the platform already KNOWS are different questions,
 * asked of different doors, and keeping all three in one file is what pushed it past the
 * 700-line ceiling.
 *
 * `checks/chain-check-wiring.ts` follows this import, so a tool exercised here counts as
 * exercised — the walk is what matters, not which file it is written in.
 */

/** The pieces chain-check owns: its live client and its recorders. Handed in rather than
 *  re-made, so this walks the same door, against the same initiative, into the same result set. */
interface ShelfDeps {
  call: (tool: string, args: unknown) => Promise<string>;
  check: (name: string, got: string, wantError: boolean, because?: RegExp) => void;
  record: (ok: boolean, name: string, got: string) => void;
  /** For the tools that degrade with a NAMED refusal when a deployment has no platform
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
  // zz-platform ships with the `zz` plugin, which every account carries — session_whoami points
  // here itself ("skill_read(\"zz-platform\")"), so this is the one skill name the door can
  // promise exists without reading this deployment's own catalog first.
  check("skill_read reads the platform's own spine skill",
    await call("skill_read", { name: "zz-platform" }), false);
  // THE MERGE, asserted on the half that has a right answer whatever this deployment holds.
  // Which owners exist depends on which flows are installed and which blocks are routed, so
  // the shelf itself can only be checked for shape (above). The refusal cannot: an owner id
  // nothing answers to must be refused by name, listing the ones that do, and that is the
  // behaviour skill_list took over from block_skills.
  check("skill_list refuses an owner no plugin or block answers to",
    await call("skill_list", { owner: "no-such-owner-chain-check" }), true,
    /is not a plugin you can reach/);

  // A subject tag says WHAT KIND of thing a piece of knowledge is about, and the kinds are a
  // closed set. Open, it becomes a free-text field that agrees with nothing.
  //
  // Every OTHER argument is filled in, and there is a positive control below. Without both,
  // a call missing a required argument is refused by the schema, the assertion sees an ERROR
  // and prints `ok` — a check that passes without ever reaching the rule it names.
  // Evidence names the INITIATIVE FOLDER, not a document inside it — knowledge_add checks the
  // shape (one plain segment) and then that a folder by that name exists in a store this
  // caller belongs to. `${INIT}/${docs[0]}` fails both, so the positive control below could
  // never have passed, and the negative control above passed for a reason that was not the
  // one it names: subjectTagError runs before the evidence loop, so the unknown kind was
  // refused first and the fixture's own invalidity never showed.
  // `scope` has no default — knowledge_add's own schema refuses a call that omits it, before
  // the handler runs at all. This was missing here, so both calls below threw a schema error
  // rather than reaching subjectTagError: the negative control passed on the WRONG refusal
  // ("`scope` says which shelf ..." never matches /is not a kind/) and would have been caught
  // by `because`, except the throw never let it get that far. `scope: "team"` is what makes
  // this the case the comments below actually describe.
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

  // knowledge_supersede needs two nodes that actually exist, on the same shelf. The id is
  // this tool's own account of what it just did — "journal node 0007 created (...)" — read
  // back rather than guessed, because a fixture id increments differently on every store.
  const oldId = /journal node (\d+) created/.exec(added)?.[1];
  if (oldId) {
    const superseding = await call("knowledge_add",
      { ...node, title: "chain-check subject probe (superseding)", tags: ["plugin:zz-core"] });
    const newId = /journal node (\d+) created/.exec(superseding)?.[1];
    if (newId) {
      // NAMING THE SHELF, because both shelves allocate from 0001 and a bare id meaning a
      // node on each is the ordinary case rather than an edge one. The fixture above is minted
      // with `scope: "team"`, so that is the shelf these two ids are on; without saying so this
      // step failed the moment the platform's shelf happened to hold the same number, which is
      // an accident of how many nodes each shelf has and not a fact about supersession.
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
}
