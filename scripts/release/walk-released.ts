/**
 * Walk the current chain-check against an already-released image.
 *
 *   npx tsx scripts/release/walk-released.ts <version>
 *
 * Not the dry run. `tool-chain.ts` proves the check green against the code about to ship;
 * this proves the other half, that a check written for a contract change actually fails on
 * the code that contract replaced. A check that passes against both measures nothing.
 *
 * Same walk, same containers, an older tag. Read the FAILED lines and satisfy yourself that
 * each names a rule you deliberately changed. Nothing is pushed and production is never
 * touched — the whole stack is a throwaway on a private network.
 */
import { die } from "../deployment.ts";
import { walkToolChain } from "./tool-chain.ts";

const version = process.argv[2];
if (!version) die("name the released version to walk against, e.g. 0.49.0");
walkToolChain(version);
