/**
 * The bug tracker, walked end to end against a live deployment.
 *
 * Separate from chain-check.ts by subject: that file is the document chain, this is a tracker
 * anybody can file into with no initiative and no flow, where the property worth proving is
 * that two people closing the same report do not overwrite each other.
 *
 * COUPLED: `checks/chain-check-wiring.ts` follows this import, so a tool exercised here counts
 * as exercised.
 */

/** The pieces chain-check owns: its live client and its two recorders. Handed in rather than
 *  re-made, so this walks the same door, against the same initiative, into the same result set.
 *  Not exported — it names this function's own parameter and nothing else constructs one. */
interface ChainDeps {
  call: (tool: string, args: unknown) => Promise<string>;
  /** The /core client, asked what it offers this token. Reading and closing reports are
   *  registered behind `if (sup)`; a run whose PAT is not superadmin is not offered them, which
   *  is a fact about the token rather than a defect. */
  admin: { tools: () => Promise<{ name: string }[]>; call: (tool: string, args: unknown) => Promise<string> };
  check: (name: string, got: string, wantError: boolean, because?: RegExp) => void;
  record: (ok: boolean, name: string, got: string) => void;
  INIT: string;
}

export async function walkBugs({ call, check, record, admin, INIT }: ChainDeps): Promise<void> {
  // Walked end to end: file, find, close, and refuse a second close. The last needs a live
  // door, being a race no unit test sees. Named for the initiative so a run's probe rows are
  // its own.
  const bugTitle = `chain-check probe ${INIT}`;

  // DELIBERATE: this asks what the token may do before filing anything. Filing is everyone's;
  // reading and closing are a superadmin's, behind `if (sup)`, and `call` throws on a tool the
  // door does not publish. A run that filed and then could not close would leave an open row.
  const offered = new Set((await admin.tools()).map((t) => t.name));
  if (!offered.has("bug_list") || !offered.has("bug_resolve") || !offered.has("bug_delete")) {
    // Not a pass: a probe that did not run is not a probe that passed, and this file's output
    // is a count somebody reads at release.
    console.log("  skip  bug_list/bug_resolve are behind `if (sup)` and this " +
                "token's role is not offered them — the tracker walk needs to close what it " +
                "files, so it files nothing");
    return;
  }

  const filed = await call("bug_report", {
    title: bugTitle,
    detail: "Filed by chain-check against a live deployment. Safe to close; it reports nothing real.",
    impact: "cosmetic", surface: "/core/mcp", initiative: INIT,
  });
  check("bug_report files a report and hands back its id", filed, false);
  const bugId = /"id":\s*"([0-9a-f-]{36})"/.exec(filed)?.[1];
  if (!bugId) {
    record(false, "bug_report files a report and hands back its id", filed.slice(0, 200));
  } else {
    // Found by searching rather than by id: a tracker whose only way in is the id you already
    // hold is a tracker nobody else can use.
    const found = await admin.call("bug_list", { query: bugTitle });
    record(found.includes(bugId), "bug_list finds a report by what it says", found.slice(0, 200));

    check("bug_resolve closes a report with what was decided",
      await admin.call("bug_resolve", { id: bugId, status: "not_a_bug", resolution: "chain-check probe; nothing was wrong." }),
      false);
    // And a second close is refused, naming who decided and what they said, rather than
    // overwriting one person's reasoning with another's.
    check("a report already closed cannot be closed again",
      await admin.call("bug_resolve", { id: bugId, status: "fixed", resolution: "second opinion" }),
      true, /already closed as/);

    // And then it takes its own row back out. `bug_resolve` keeps what it closes, that being
    // the record of what the platform has fixed, and a probe does not belong in it.
    check("bug_delete removes a row that was never a report",
      await admin.call("bug_delete", { id: bugId }), false, /"deleted"/);
    // Asked of the tracker rather than assumed from a success message.
    const after = await admin.call("bug_list", { query: bugTitle, status: "not_a_bug" });
    record(!after.includes(bugId), "the probe row is gone from the tracker", after.slice(0, 200));
  }
}
