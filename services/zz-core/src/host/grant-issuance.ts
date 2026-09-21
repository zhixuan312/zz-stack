/**
 * The guard that keeps grant issuance off every door this process serves.
 *
 * THE ENGINE IS NOT HERE, for the reason `registry.ts` beside this file already gives:
 * `@zz/contracts` owns what a grant is, how one is derived from a stored decision and what
 * the public claim handler re-checks, because a fixture has to drive the same engine the
 * service drives and this package sits above it in the dependency graph. What this module
 * owns is the part that is genuinely the service's: the registration guard. Which components
 * may issue, and the deriving of a grant from a stored decision, are the engine's; a fact
 * about which names a DOOR registers has nowhere else it could live.
 *
 * WHY A GUARD AND NOT JUST AN OMISSION. The acceptance criterion is that issuance is absent
 * from every registry including admin enumeration, and the ordinary way to satisfy that is to
 * not write the registration — which is exactly as durable as everybody remembering. A door
 * added next release, a handler table built by reflection over an exports object, a
 * convenience that registers every function in a module: each of those puts the name back
 * without anybody deciding to. {@link refuseIssuanceInRegistry} turns "nobody registered it"
 * into "registering it fails the process at boot", which is the difference between a name
 * being hidden and an operation being unreachable.
 *
 * A REFUSAL IS THROWN, not returned — again as `registry.ts` argues. Everything here runs at
 * the composition root before the process serves anything, so there is no caller to hand a
 * soft answer to, and a host that came up having silently skipped this check would be a host
 * whose safety depends on a failure nobody saw.
 */
import { INTERNAL_GRANT_ISSUANCE } from "@zz/contracts";

import { Refusal } from "../refusal.js";

/**
 * Refuse a door that is about to register the issuance operation.
 *
 * SWEPT FROM THE NAMES THE DOOR IS ABOUT TO REGISTER, which is the list the door itself is
 * built from, so a name that arrives there by reflection is caught exactly as a name somebody
 * typed. `door` is in the message because a process serving three of them needs to be told
 * which one, and a refusal that says only "somewhere" is a refusal somebody has to go looking
 * for.
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
