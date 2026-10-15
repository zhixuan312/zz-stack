/**
 * The one normalisation a refusal's stored text is grouped by: lower-cased, with a UUID or a digit
 * run folded to `#`, so two refusals that differ only by which run's id or which retry count they
 * carried read as one text. A refusal with no text normalises to the empty string.
 *
 * In contracts because two services group by it: zz-core's evaluation (`refusalDetail` and
 * DISCOVER's `refusalGroups`) and the gateway's Activity. A copy in either would fold one sentence
 * two ways.
 *
 * COUPLED: services/gateway/src/console/refusals.ts spells `normalizedRefusalSql("e.refusal")` out
 * as a literal, because the gate holds every console query to a statement check:sql can PREPARE
 * whole; checks/console-refusals.ts fails when the two differ.
 */

/** The SQL expression that normalises the refusal text in `column`, on one line. */
export function normalizedRefusalSql(column: string): string {
  return `lower(regexp_replace(regexp_replace(coalesce(${column}, ''), ` +
    `'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '#', 'gi'), '[0-9]+', '#', 'g'))`;
}
