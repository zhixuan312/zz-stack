/**
 * benchmark-route.ts — one question, and it is not "what did this run recall": DID THIS CALL
 * ACTUALLY TRAVEL THE PUBLIC PATH?
 *
 * ITS OWN FILE BECAUSE IT IS ITS OWN SUBJECT, and the seam is visible in what each half is
 * made of. Everything here is about a call's MECHANISM — which statements a request issued,
 * whether the answer was the published contract, whether the caller's own id was bound into
 * the reads — and none of it knows what a slice, a denominator or a relevant artifact is.
 * `benchmark-measure.ts` is the opposite: it knows those three and nothing about SQL. They also
 * fail differently, which is the surer test of a seam. A fault here means the measurement was
 * taken through a path nobody can vouch for and the numbers must not be read at all; a fault
 * there means the numbers are wrong. The first refuses before anything is written; the second
 * is a slice below its target.
 *
 * WHY ANY OF IT EXISTS. `route` is the field a release check compares against the literal
 * `"public_handler"`, and a producer could simply write that word. A report that merely SAYS it
 * went through the handler is structurally indistinguishable from one that did not, so the
 * string is EARNED here — from statements a wrapper actually saw go past — or it is a named
 * refusal. There is no third outcome and no way to assert one.
 *
 * WHAT `"public_handler"` DENOTES ON THIS DEPLOYMENT is a function call, not a door. No MCP
 * handler sits above this path yet: `services/zz-core/src/tools/knowledge-search.ts:26` keeps
 * the live `knowledge_search` tool on `zz.doc`/`zz.knowledge_node` and calls repointing it a
 * cutover step rather than a wiring step, and `services/zz-core/src/tenant-info/search.ts:23`
 * says the same from the other side. The report carries that distinction beside the word, in
 * `route_denotes`, so the literal cannot be read as a transport claim.
 */
import type { RetrievalClient } from "../../services/zz-core/dist/tenant-info/retrieval.js";

/** One statement as the wrapper saw it. Not exported: it is the shape `instrument` hands
 *  straight back to `observeRoute`, and every caller reaches it through those two rather than
 *  naming it. */
interface ObservedStatement {
  readonly text: string;
  readonly params: readonly unknown[];
}

/**
 * The five statement shapes the composed path issues, named by the same substrings
 * `testing/tenant-info/compatibility-retrieval.ts`'s own fake store routes on — one vocabulary
 * for "which query is this", not two. A run that did not issue a registry read, a lane and a
 * watermark read did not travel the composed path, whatever it claims.
 */
const STATEMENT_MARKERS = Object.freeze({
  registry: "published_artifacts",
  watermark: "artifact_projection_watermark",
  hydration: "head_event_sequence",
  edges: "zz.artifact_edge",
  lane_lexical: "to_bm25query",
  lane_identifier: "zz.artifact_identifier",
});

/** The markers a single `searchTenantInformation` call MUST have issued. The two lane markers
 *  are an either/or — which lanes fire depends on the query's own terms — so they are checked
 *  as a disjunction below rather than listed here. */
const REQUIRED_MARKERS = ["registry", "watermark"] as const;

export interface RouteObservation {
  readonly markers: Readonly<Record<string, number>>;
  readonly lane_statements: number;
  readonly contract_parsed: boolean;
  readonly statements: number;
  readonly owner_bound_statements: number;
}

/** Wraps any `RetrievalClient` and records every statement it was asked to run. The wrapper
 *  never answers a query itself — it forwards and remembers — so instrumenting the client
 *  cannot change what was measured. */
export function instrument(client: RetrievalClient): { client: RetrievalClient; log: ObservedStatement[] } {
  const log: ObservedStatement[] = [];
  return {
    log,
    client: {
      query: async <T>(text: string, params: readonly unknown[] = []) => {
        log.push({ text, params });
        return client.query<T>(text, params);
      },
    },
  };
}

/**
 * What one call actually did, from the statements it issued and the response it produced.
 *
 * `owner_bound_statements` is the authorized-read receipt in its smallest honest form: the
 * count of statements that carried the authenticated caller's own id as a BOUND PARAMETER.
 * A read of another tenant's rows cannot be performed by a statement whose predicates are all
 * bound to this caller, and a statement that binds nothing about the caller is one this receipt
 * declines to vouch for.
 */
export function observeRoute(
  log: readonly ObservedStatement[], ownerId: string, contractParsed: boolean,
): RouteObservation {
  const markers: Record<string, number> = {};
  for (const [name, needle] of Object.entries(STATEMENT_MARKERS)) {
    markers[name] = log.filter((s) => s.text.includes(needle)).length;
  }
  const ownerBound = log.filter((s) => JSON.stringify(s.params).includes(ownerId)).length;
  return {
    markers,
    lane_statements: markers.lane_lexical + markers.lane_identifier,
    contract_parsed: contractParsed,
    statements: log.length,
    owner_bound_statements: ownerBound,
  };
}

/**
 * `"public_handler"` or a named refusal — and the refusal is the default. The string the frozen
 * check compares against is produced HERE, from the observations above, so a report claiming
 * the public handler is claiming that every one of these held for every measured query.
 */
export function computeRoute(observations: readonly RouteObservation[]): string {
  if (observations.length === 0) return "unverified: no call was observed";
  for (const marker of REQUIRED_MARKERS) {
    const missing = observations.filter((o) => (o.markers[marker] ?? 0) === 0).length;
    if (missing > 0) {
      return `unverified: ${missing} call(s) issued no ${marker} statement, so the composed path was not travelled`;
    }
  }
  const noLane = observations.filter((o) => o.lane_statements === 0).length;
  if (noLane > 0) return `unverified: ${noLane} call(s) reached no retrieval lane`;
  const unparsed = observations.filter((o) => !o.contract_parsed).length;
  if (unparsed > 0) return `unverified: ${unparsed} response(s) are not the published SearchResponse`;
  const unbound = observations.filter((o) => o.owner_bound_statements === 0).length;
  if (unbound > 0) return `unverified: ${unbound} call(s) bound no caller identity into any statement`;
  return "public_handler";
}
