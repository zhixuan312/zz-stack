#!/usr/bin/env node
/**
 * checks/tag-blank-refused.ts — the one tag rule every write path into `zz.doc.tags` asks
 * (`tagRefusal`, paths.ts), pure: nothing but the built `paths.js`.
 *
 *   node checks/tag-blank-refused.ts   # needs a built tree (`npm run build`)
 *
 * A tag is judged as it will be stored, trimmed: a blank one is refused rather than stored as a tag
 * no search can name, and a tag sent with spaces around it is the tag inside them.
 *
 * Exit 0: every case held. Exit 1: the failing cases, each with what it got.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const P = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/paths.js")).href) as {
  tagRefusal(tags: string[] | undefined): string | null;
};

let failed = 0;
const holds = (name: string, ok: boolean, got: unknown): void => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n         got ${JSON.stringify(got)}`}`);
};

const empty = P.tagRefusal([""]);
holds("an empty tag is refused", typeof empty === "string" && /"" is not a tag/.test(empty), empty);
const spaces = P.tagRefusal(["alpha", "   "]);
holds("a tag of spaces is refused beside a good one", typeof spaces === "string" && /"" is not a tag/.test(spaces), spaces);
holds("a tag sent with spaces around it is the tag inside them", P.tagRefusal([" alpha ", "flow:sdlc-flow"]) === null, null);
holds("no tags are no tags", P.tagRefusal(undefined) === null && P.tagRefusal([]) === null, null);

if (failed) { console.error(`\ntag-blank-refused: ${failed} case(s) failed`); process.exit(1); }
console.log("\ntag-blank-refused: blank tags refused, padded tags read trimmed: ok");
