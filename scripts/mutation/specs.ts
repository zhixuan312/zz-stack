/**
 * Every planted defect, in one list, split by what it is planted in.
 *
 * Split by subject rather than by check name: a mutation is only as good as the understanding
 * of the file it lands in, and these groups reach their check four different ways —
 * through the build, through the build plus a fixture, through source text this repository
 * sweeps, and through shipped content. One file would also be over this repository's
 * seven-hundred-line ceiling.
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
 * DELIBERATE: the `specs-cov-*` files are grouped by which check they cover, not by subject,
 * departing from the rule above. Their subjects are scattered across services, packages,
 * scripts, catalog, deploy and testing, so a subject grouping would split one check's defects
 * across several files.
 *
 * The check ids that cannot be planted are recorded in `unexercisable.ts` with the reason.
 */
export const SPECS: readonly MutationSpec[] =
  [...KERNEL_SPECS, ...RETRIEVAL_SPECS, ...PLATFORM_SPECS, ...CATALOG_SPECS, ...DOCUMENT_SPECS,
   ...COV_BUILD, ...COV_CATALOG, ...COV_DEPLOY, ...COV_DOCUMENTS, ...COV_KNOWLEDGE,
   ...COV_SECURITY, ...COV_SKILLS,
   ...COV_SUITES_1, ...COV_SUITES_2, ...COV_SUITES_3, ...COV_SUITES_4];
