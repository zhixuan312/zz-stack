#!/usr/bin/env node
/**
 * The stored-body limit is one number and bounds the body: `buildRowVector`, which every analyzed
 * byte goes through, accepts a body of exactly `MAX_INPUT_BYTES` under a title and tags, refuses
 * one byte more with the refusal every write path returns, and the limit is the upload limit, so
 * a file an upload accepts is a body a write accepts.
 *
 * Pure: no database, no network. Reads the built `packages/indexing/dist`.
 * Run: node checks/stored-body-limit.ts
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { UPLOAD_MAX_BYTES } from "@zz/contracts";

type Indexing = typeof import("../packages/indexing/dist/index.js");
const { MAX_INPUT_BYTES, buildRowVector, inputLimitRefusal }: Indexing =
  await import(pathToFileURL(join(process.cwd(), "packages/indexing/dist/index.js")).href);

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };
const build = (body: string): string | null => {
  try {
    buildRowVector({ title: "A title for the body", tags: ["plan", "upload"], body });
    return null;
  } catch (err) {
    return inputLimitRefusal("the body", err) ?? `threw something else: ${String(err)}`;
  }
};

is(MAX_INPUT_BYTES === UPLOAD_MAX_BYTES,
   `the stored-body limit ${MAX_INPUT_BYTES} is the upload limit ${UPLOAD_MAX_BYTES}`);
const atLimit = build("a".repeat(MAX_INPUT_BYTES));
is(atLimit === null, `a body of exactly the limit under a title and tags is accepted, got ${atLimit}`);
const past = build("a".repeat(MAX_INPUT_BYTES + 1));
is(past !== null && past.startsWith("ERROR: SIZE_LIMIT — ") && /nothing was written/.test(past),
   `a body one byte past the limit is refused by name, got ${past}`);

if (fail.length) {
  for (const f of fail) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log("stored-body-limit: the body is bounded by the upload limit, at the limit accepted and past it refused: ok");
