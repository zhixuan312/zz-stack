/**
 * The bug tracker, walked end to end against a live deployment.
 *
 * SPLIT OUT OF chain-check.ts BY SUBJECT, not by line count. That file is about the document
 * chain — write, gate, approve, close, and the refusals that hold the sequence together. A
 * tracker is a different thing: anybody can file one, from anywhere, with no initiative and no
 * flow, and the property worth proving is that two people closing the same report do not
 * overwrite each other. Keeping both in one file was what pushed it past the 700-line ceiling,
 * and the ceiling is where this repository has always found a second subject hiding.
 *
 * `checks/chain-check-wiring.ts` follows this import, so a tool exercised here counts as
 * exercised — the walk is what matters, not which file it is written in.
 */

/** The pieces chain-check owns: its live client and its two recorders. Handed in rather than
 *  re-made, so this walks the same door, against the same initiative, into the same result set.
 *  Not exported — it names this function's own parameter and nothing else constructs one. */
interface ChainDeps {
  call: (tool: string, args: unknown) => Promise<string>;
  /** The /manage door, and what it offers THIS token. Reading and closing reports are
   *  superadmin acts and live there; a run whose PAT is not superadmin is not offered them,
   *  which is a fact about the token rather than a defect. */
  manage: { tools: () => Promise<{ name: string }[]>; call: (tool: string, args: unknown) => Promise<string> };
  check: (name: string, got: string, wantError: boolean, because?: RegExp) => void;
  record: (ok: boolean, name: string, got: string) => void;
  INIT: string;
}

export async function walkBugs({ call, check, record, manage, INIT }: ChainDeps): Promise<void> {
  // A REPORT IS THE ONE THING ANYBODY CAN DO, so it is walked end to end: file, find, close,
  // and refuse a second close. The last is the one that needs a live door — two people closing
  // the same report must not overwrite each other's reasoning, and that is a race no unit test
  // sees. Named for the initiative so a run's probe rows are its own.
  const bugTitle = `chain-check probe ${INIT}`;

  // ASK WHAT THIS TOKEN MAY DO BEFORE FILING ANYTHING, not after.
  //
  // READING AND CLOSING ARE ON /manage, BEHIND `if (sup)`. Filing is everyone's and goes
  // through /core; answering is an operator's and goes through /manage. A token whose role is
  // not superadmin is not offered the latter, and `call` THROWS on a tool the door does not
  // publish — so the door's own list decides whether this walk runs at all.
  //
  // This check used to sit AFTER bug_report, and the consequence was a real one: a run whose
  // PAT is not superadmin filed a report it had no way to close, so every such run left an
  // open row in the tracker for ever. Four of them accumulated across 0.36.1 to 0.38.0 and had
  // to be deleted by hand. There is no `bug_delete` on any door — `bug_resolve` closes a report
  // and nothing removes one — so the only moment this probe can avoid the litter is before it
  // creates it. A probe that cannot clean up after itself does not get to run.
  const offered = new Set((await manage.tools()).map((t) => t.name));
  if (!offered.has("bug_list") || !offered.has("bug_resolve")) {
    // NOT a pass. A probe that did not run is not a probe that passed, and this file's output
    // is a count somebody reads at release.
    console.log("  skip  bug_list/bug_resolve are on /manage behind `if (sup)` and this " +
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
    // Found by SEARCHING rather than by id: a tracker whose only way in is the id you already
    // hold is a tracker nobody else can use.
    const found = await manage.call("bug_list", { query: bugTitle });
    record(found.includes(bugId), "bug_list finds a report by what it says", found.slice(0, 200));

    check("bug_resolve closes a report with what was decided",
      await manage.call("bug_resolve", { id: bugId, status: "not_a_bug", resolution: "chain-check probe; nothing was wrong." }),
      false);
    // AND A SECOND CLOSE IS REFUSED, naming who decided and what they said — not silently
    // overwritten, which is how one person's reasoning disappears under another's.
    check("a report already closed cannot be closed again",
      await manage.call("bug_resolve", { id: bugId, status: "fixed", resolution: "second opinion" }),
      true, /already closed as/);
  }
}
