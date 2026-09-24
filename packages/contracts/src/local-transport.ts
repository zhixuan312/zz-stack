/**
 * Where a request is allowed to go, declared per profile and never inferred.
 *
 * Every endpoint in the register below carries its own `locality` and `data_profile`, written
 * down when the profile was declared. Nothing reads a profile's name: an undeclared name
 * resolves to `unresolved`, with `declared: false` and no endpoint, so a profile called
 * `local-anything` that nobody declared gets no local endpoint.
 *
 * A fallback is a declaration too. `local-only`'s is local, so the route exists, is exercised
 * when the primary is unavailable, and still does not leave the premises.
 * `local-first-cloud-declared` reaches a cloud endpoint on the same path, and its declaration
 * says so. What this separates is a cloud route somebody chose from one somebody arrived at.
 *
 * A laptop is not infrastructure. `local-workstation` is declared and usable from a
 * workstation; asked for by the server-side controller it resolves local, declared, and not
 * usable, with the reason saying a production local profile needs a host-owned or
 * independently managed endpoint.
 *
 * Handles, never addresses. Every `endpoint_ref` below is a host-held handle in the dotted
 * lowercase shape the profile register accepts. Nothing here dereferences one — resolution
 * answers which endpoint, and the host that holds the handle answers where it is.
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
 * The declared profiles. Four, each earning its place against one clause of the contract.
 *
 * `local-only` — a local primary and a local fallback, so "does not fall back to the cloud" is
 *   demonstrated by a profile that genuinely falls back. Its standby is independently managed,
 *   which is why that data profile is in the union at all.
 * `local-workstation` — declared, and refused to a server-side controller.
 * `cloud-only` — the honest cloud profile, so `local` is a choice rather than the only word.
 * `local-first-cloud-declared` — a cloud fallback permitted because it is written here.
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
 * Which endpoint this profile reaches, given that its primary may be down and given who is
 * asking.
 *
 * When nothing resolves, `kind` still reports the profile's declared locality: a local-only
 * profile whose primary is down and which declares no fallback has no endpoint and is still a
 * local-only profile. `usable: false` is what stops the caller; the locality is what tells them
 * what they were promised.
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
