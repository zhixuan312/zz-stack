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
import { COV_BUILD } from "./specs-cov-build.ts";
import { COV_CATALOG } from "./specs-cov-catalog.ts";
import { COV_DEPLOY } from "./specs-cov-deploy.ts";
import { COV_DOCUMENTS } from "./specs-cov-documents.ts";
import { COV_KNOWLEDGE } from "./specs-cov-knowledge.ts";
import { COV_SECURITY } from "./specs-cov-security.ts";
import { COV_SKILLS } from "./specs-cov-skills.ts";
import { COV_SUITES_1 } from "./specs-cov-suites-1.ts";
import { COV_SUITES_2 } from "./specs-cov-suites-2.ts";
import { COV_SUITES_3 } from "./specs-cov-suites-3.ts";
import { COV_SUITES_4 } from "./specs-cov-suites-4.ts";
import { DOCUMENT_SPECS } from "./specs-documents.ts";
import { KERNEL_SPECS } from "./specs-kernel.ts";
import { PLATFORM_SPECS } from "./specs-platform.ts";
import { RETRIEVAL_SPECS } from "./specs-retrieval.ts";

/**
 * THE `specs-cov-*` FILES ARE GROUPED BY WHICH CHECK THEY COVER, not by subject, and that is a
 * deliberate departure from the rule above.
 *
 * The five original files are split by what a defect is planted IN, because a reader coming back
 * to one of them needs the file it lands in. These eleven were written to close a coverage gap —
 * 331 registered checks with no row — and the unit of that work is the CHECK, not the subject.
 * Their subjects are scattered across services, packages, scripts, catalog, deploy and testing;
 * grouping them by subject would have meant eleven authors editing the same five files.
 *
 * Each was written by one author against one list of check ids, and each verified its own anchors
 * before delivering. Between them they carry 318 specs; the remaining 13 ids are recorded in
 * `unexercisable.ts` with the reason none of them can be planted.
 */
export const SPECS: readonly MutationSpec[] =
  [...KERNEL_SPECS, ...RETRIEVAL_SPECS, ...PLATFORM_SPECS, ...CATALOG_SPECS, ...DOCUMENT_SPECS,
   ...COV_BUILD, ...COV_CATALOG, ...COV_DEPLOY, ...COV_DOCUMENTS, ...COV_KNOWLEDGE,
   ...COV_SECURITY, ...COV_SKILLS,
   ...COV_SUITES_1, ...COV_SUITES_2, ...COV_SUITES_3, ...COV_SUITES_4];
