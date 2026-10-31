#!/usr/bin/env node
/**
 * zz-migrate opens its archive initiative the way zz-core accepts, and a run stopped between the
 * open and explore.md resumes rather than refusing itself forever.
 *
 *   node checks/zz-migrate-archive.ts   # needs a built tree (`npm run build`)
 *
 * The door is a fake that answers initiative_open with zz-core's own rules, imported from its build:
 * `slugRefusal` refuses a slug that already starts with a date, `initiativeNameFor` names the
 * initiative, and a name already opened is refused as taken.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { EXPLORE_SENT, openArchive, type Ledger } from "../catalog/zz/zz-access/skills/zz-migrate/archive.ts";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { slugRefusal } = await load("services/zz-core/dist/document-rules.js") as { slugRefusal: (s: string) => string | null };
const { initiativeNameFor } = await load("services/zz-core/dist/initiative-record.js") as { initiativeNameFor: (s: string) => string };

const fail: string[] = [];
const EXPLORE = { content: "# The mma archive of Repo\n", title: "The mma archive of Repo" };

/** A door holding what was opened and written; `breakWrite` refuses the next document_write once. */
function door() {
  const opened = new Set<string>();
  const written: string[] = [];
  let breakWrite = false;
  const refuse = (text: string): never => { throw new Error(text); };
  return {
    opened, written, breakNextWrite: () => { breakWrite = true; },
    async call(tool: string, args: Record<string, unknown>): Promise<string> {
      if (tool === "initiative_open") {
        const slug = String(args.slug);
        const bad = slugRefusal(slug);
        if (bad) refuse(bad);
        const name = initiativeNameFor(slug);
        if (opened.has(name)) refuse(`ERROR: "${name}" is already taken`);
        opened.add(name);
        return JSON.stringify({ initiative: name, flow: args.flow });
      }
      if (tool === "document_write") {
        if (breakWrite) { breakWrite = false; refuse("ERROR: timed out"); }
        written.push(String(args.path));
        return "ok";
      }
      return refuse(`ERROR: unexpected ${tool}`);
    },
  };
}

const run = async (core: ReturnType<typeof door>, ledger: Ledger): Promise<string | Error> => {
  try {
    return await openArchive(core, "Repo", ledger, (k, v) => { ledger[k] = v; }, EXPLORE);
  } catch (e) { return e as Error; }
};

// 1. A fresh ledger opens an initiative zz-core accepts and writes explore.md into the name it answered.
{
  const core = door(), ledger: Ledger = {};
  const name = await run(core, ledger);
  if (name instanceof Error) fail.push(`a fresh import was refused: ${name.message}`);
  else if (ledger.__initiative !== name || core.written.join() !== `${name}/explore.md`) {
    fail.push(`a fresh import recorded ${String(ledger.__initiative)} and wrote ${core.written.join()} for ${name}`);
  }
}

// 2. explore.md failing after the open: the rerun opens nothing and writes it into the same initiative.
{
  const core = door(), ledger: Ledger = {};
  core.breakNextWrite();
  const first = await run(core, ledger);
  if (!(first instanceof Error)) fail.push("a refused explore.md write did not stop the run");
  const again = await run(core, ledger);
  if (again instanceof Error) fail.push(`the rerun after a failed explore.md was refused: ${again.message}`);
  else if (core.opened.size !== 1 || core.written.join() !== `${again}/explore.md` || ledger[EXPLORE_SENT] !== true) {
    fail.push(`the rerun opened ${core.opened.size} and wrote ${core.written.join()}`);
  }
}

// 3. A ledger that holds both sends nothing.
{
  const core = door(), ledger: Ledger = { __initiative: "2026-01-01-mma-archive-repo", [EXPLORE_SENT]: true };
  const name = await run(core, ledger);
  if (name !== "2026-01-01-mma-archive-repo" || core.opened.size || core.written.length) {
    fail.push(`a finished archive sent again: opened ${core.opened.size}, wrote ${core.written.length}`);
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("zz-migrate archive: ok");
