/**
 * Every planted defect, in one list, split by what it is planted IN.
 *
 * Split by subject rather than by check name, because that is what a reader coming back to
 * one of these needs: a mutation is only as good as the understanding of the file it lands
 * in, and the four groups here have four different ways of reaching their check — through
 * the build, through the build plus a fixture, through source text this repository sweeps,
 * and through shipped content. One file of sixty-five would also be over this repository's
 * seven-hundred-line ceiling, which is where a file here has always turned out to hold a
 * second subject.
 */
import type { MutationSpec } from "./plant.ts";
import { CATALOG_SPECS } from "./specs-catalog.ts";
import { DOCUMENT_SPECS } from "./specs-documents.ts";
import { KERNEL_SPECS } from "./specs-kernel.ts";
import { PLATFORM_SPECS } from "./specs-platform.ts";
import { RETRIEVAL_SPECS } from "./specs-retrieval.ts";

export const SPECS: readonly MutationSpec[] =
  [...KERNEL_SPECS, ...RETRIEVAL_SPECS, ...PLATFORM_SPECS, ...CATALOG_SPECS, ...DOCUMENT_SPECS];
