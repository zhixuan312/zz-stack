/**
 * The guard that keeps grant issuance off every door this process serves.
 *
 * DELIBERATE: the engine is not here, for the reason `registry.ts` beside this file gives.
 * `@zz/contracts` owns what a grant is, how one is derived from a stored decision and what the
 * public claim handler re-checks, because a fixture has to drive the same engine the service
 * drives and this package sits above it in the dependency graph. What this module owns is the
 * registration guard — a fact about which names a door registers has nowhere else it could live.
 *
 * A guard rather than an omission: not writing the registration is exactly as durable as everybody
 * remembering. A door added next release, a handler table built by reflection over an exports
 * object, or a convenience that registers every function in a module each puts the name back
 * without anybody deciding to. {@link refuseIssuanceInRegistry} turns "nobody registered it" into
 * "registering it fails the process at boot".
 *
 * A refusal is thrown, not returned: everything here runs at the composition root before the
 * process serves anything, so there is no caller to hand a soft answer to, and a host that came up
 * having silently skipped this check would depend on a failure nobody saw.
 */
import { INTERNAL_GRANT_ISSUANCE } from "@zz/contracts";

import { Refusal } from "../refusal.js";

/**
 * Refuse a door that is about to register the issuance operation.
 *
 * Swept from the names the door is about to register, which is the list the door itself is built
 * from, so a name that arrives there by reflection is caught exactly as a name somebody typed.
 * `door` is in the message because a process serving several of them needs to be told which one.
 */
export function refuseIssuanceInRegistry(door: string, names: readonly string[]): void {
  if (names.includes(INTERNAL_GRANT_ISSUANCE)) {
    throw new Refusal(
      `ERROR: ${door} is registering ${INTERNAL_GRANT_ISSUANCE} — grant issuance is reached ` +
      "from a trusted host context after a stored controller decision and from nowhere else. " +
      "A registered issuance operation is reachable by a direct call from anybody the door " +
      "admits, and no role, including an administrative one, confers the authority to mint " +
      "authority",
    );
  }
}
