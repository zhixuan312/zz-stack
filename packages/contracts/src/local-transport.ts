/**
 * WHERE A REQUEST IS ALLOWED TO GO, declared per profile and never inferred.
 *
 * The failure mode is a quiet one. A profile called `local-only` has its primary backend go
 * down; a transport helpfully retries against the configured cloud route; the run completes and
 * looks exactly like every other run. Nobody is told, because nothing failed. Whatever the
 * local-only profile existed to keep off a third party's hardware has just been sent there.
 *
 * SO LOCALITY IS A FIELD, NOT A GUESS. Every endpoint in the register below carries its own
 * `locality` and `data_profile`, written down when the profile was declared. Nothing here reads
 * a profile's NAME to work out where it goes — and the proof of that is what an undeclared name
 * resolves to: `unresolved`, with `declared: false` and no endpoint at all. A profile called
 * `local-anything` that nobody declared gets no local endpoint, because a product name is
 * marketing and a declaration is a commitment.
 *
 * A FALLBACK IS A DECLARATION TOO. `local-only` has one — and it is local, which is the whole
 * demonstration: the route exists, it is exercised when the primary is unavailable, and it
 * still does not leave the premises. `local-first-cloud-declared` reaches a cloud endpoint on
 * the same path, and that is fine, because its declaration says so in the register where an
 * operator reading it can see it. The distinction this module enforces is between a cloud route
 * somebody chose and a cloud route somebody arrived at.
 *
 * AND A LAPTOP IS NOT INFRASTRUCTURE. A backend on a worker's workstation is not reachable or
 * trusted by a server-side controller, whatever the network happens to allow on a given
 * afternoon. `local-workstation` is declared and usable — from a workstation. Asked for by the
 * server-side controller, it resolves local, declared, and NOT usable, with the reason saying a
 * production local profile needs a host-owned or independently managed endpoint.
 *
 * HANDLES, NEVER ADDRESSES. Every `endpoint_ref` below is a host-held handle in the same dotted
 * lowercase shape the profile register accepts. No URL, no authority, no credential, and
 * nothing in this module dereferences one — resolution answers WHICH endpoint, and the host
 * that holds the handle answers where it is.
 */

/** Local, cloud, or nothing resolved. The third is not a failure to be smoothed over: it is
 *  what an undeclared profile name is worth. */
type EndpointLocality = "local" | "cloud" | "unresolved";

/** Who runs the machine, which is the question `local` on its own does not answer. */
type DataProfile =
  /** Run by the host that operates the controller. */
  | "host_owned"
  /** Run by a third party under an arrangement the host does not operate but has qualified. */
  | "independently_managed"
  /** Run by one person on their own machine. Fine for that person; not infrastructure. */
  | "worker_workstation"
  /** Run by a vendor, off the premises. */
  | "vendor_hosted";

/** Which controller is asking. The default is the strict one: a server-side controller is what
 *  production runs on, and assuming the permissive case would make the laptop rule opt-in. */
type ControllerSite = "server_side" | "workstation";

interface DeclaredEndpoint {
  readonly endpoint_ref: string;
  readonly locality: "local" | "cloud";
  readonly data_profile: DataProfile;
}

interface TransportProfile {
  readonly primary: DeclaredEndpoint;
  /** Null is a declaration: this profile has no second route, and none is substituted. */
  readonly fallback: DeclaredEndpoint | null;
}

/**
 * THE DECLARED PROFILES. Four, each earning its place against one clause of the contract.
 *
 * `local-only` — a local primary AND a local fallback, so "does not fall back to the cloud" is
 *   demonstrated by a profile that genuinely falls back, rather than by one with nowhere to go.
 *   Its standby is independently managed: a real arrangement, and the reason that data profile
 *   is in the union at all.
 * `local-workstation` — declared, and refused to a server-side controller.
 * `cloud-only` — the honest cloud profile, so `local` is a choice rather than the only word.
 * `local-first-cloud-declared` — a cloud fallback that is permitted BECAUSE it is written here.
 */
const REGISTER: ReadonlyMap<string, TransportProfile> = new Map([
  ["local-only", {
    primary: { endpoint_ref: "local.host.primary", locality: "local", data_profile: "host_owned" },
    fallback: { endpoint_ref: "local.host.standby", locality: "local", data_profile: "independently_managed" },
  }],
  ["local-workstation", {
    primary: { endpoint_ref: "local.workstation", locality: "local", data_profile: "worker_workstation" },
    fallback: null,
  }],
  ["cloud-only", {
    primary: { endpoint_ref: "cloud.vendor.primary", locality: "cloud", data_profile: "vendor_hosted" },
    fallback: null,
  }],
  ["local-first-cloud-declared", {
    primary: { endpoint_ref: "local.host.primary", locality: "local", data_profile: "host_owned" },
    fallback: { endpoint_ref: "cloud.vendor.primary", locality: "cloud", data_profile: "vendor_hosted" },
  }],
] as const);

interface EndpointRequest {
  readonly profile: string;
  readonly primaryUnavailable?: boolean;
  readonly controller?: ControllerSite;
}

interface ResolvedEndpoint {
  readonly profile: string;
  readonly kind: EndpointLocality;
  /** Did this locality come out of the register. False means nobody declared the profile, and
   *  the locality below is `unresolved` rather than a reading of the name. */
  readonly declared: boolean;
  readonly endpoint_ref: string | null;
  readonly data_profile: DataProfile | null;
  readonly usable: boolean;
  readonly reason: string;
}

const resolved = (
  profile: string,
  kind: EndpointLocality,
  declared: boolean,
  endpoint: DeclaredEndpoint | null,
  usable: boolean,
  reason: string,
): ResolvedEndpoint => Object.freeze({
  profile,
  kind,
  declared,
  endpoint_ref: endpoint?.endpoint_ref ?? null,
  data_profile: endpoint?.data_profile ?? null,
  usable,
  reason,
});

/**
 * WHICH ENDPOINT THIS PROFILE REACHES, given that its primary may be down and given who is
 * asking.
 *
 * WHEN NOTHING RESOLVES, `kind` STILL REPORTS THE PROFILE'S DECLARED LOCALITY. A local-only
 * profile whose primary is down and which declares no fallback has no endpoint — but it is
 * still a local-only profile, and reporting anything else would make "did this run stay local"
 * unanswerable exactly when the answer matters. `usable: false` is what stops the caller; the
 * locality is what tells them what they were promised.
 */
export function resolveEndpoint(request: EndpointRequest): ResolvedEndpoint {
  const profile = REGISTER.get(request.profile);
  if (profile === undefined) {
    return resolved(request.profile, "unresolved", false, null, false,
      `no transport profile named ${request.profile} is declared, and locality is never inferred from a name`);
  }

  const chosen = request.primaryUnavailable ? profile.fallback : profile.primary;
  if (chosen === null) {
    return resolved(request.profile, profile.primary.locality, true, null, false,
      "the primary is unavailable and this profile declares no fallback, so there is no route to take");
  }

  const controller = request.controller ?? "server_side";
  if (chosen.data_profile === "worker_workstation" && controller === "server_side") {
    return resolved(request.profile, chosen.locality, true, chosen, false,
      `${chosen.endpoint_ref} runs on a worker's workstation and is neither reachable nor trusted by a `
      + "server-side controller; a production local profile needs a host-owned or independently managed endpoint");
  }

  return resolved(request.profile, chosen.locality, true, chosen, true,
    request.primaryUnavailable
      ? `the primary is unavailable and this profile declares ${chosen.endpoint_ref}, which is ${chosen.locality}`
      : `this profile declares ${chosen.endpoint_ref}, which is ${chosen.locality}`);
}
