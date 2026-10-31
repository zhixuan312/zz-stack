/**
 * What the platform records, and whether anything can read it back.

 * Columns against their writers, arity against the statements that bind it, the frozen alias
 * maps against the code that resolves through them, and the telemetry a call leaves behind.
 * A defect in any of these is silent by construction — a row is written, a query returns, and
 * the number is simply wrong — which is why they are checks and not tests.
 */
import { check } from "../run.ts";
import { runsCheck } from "../suite-runner.ts";

check("an aggregate nothing measured renders as null, never a confident zero",
      runsCheck("console-nulls.ts"));

check("SCHEMA.md states the standard the spec fixed", runsCheck("schema-standard.ts"));
check("the real migrations produce SCHEMA_TARGET's catalog, exactly", runsCheck("schema-inventory.ts"));
check("every throwaway container and network is labelled with the process that started it, and a starter removes what a killed one left before it starts anything",
      runsCheck("owned-containers.ts"));
// Compared at its own grain against the statement it replaces, so a wrong
// key cannot hide behind a right total, and both write paths are re-read through it rather than trusted.
check("the read model answers what the statement it replaces answers, and composes with it",
      runsCheck("event-work-week.ts"));
// The model is a projection of zz.event and holds nothing a rebuild cannot reproduce; the decision
// about what reads it is written, six metrics and a two-number budget.
check("the read model holds no business state it cannot rebuild, and its register is written",
      runsCheck("event-work-week-columns.ts"));
// It damages a seeded throwaway's model three ways and holds the rebuild to
// putting every business key and value back with `built_at` excluded, then holds `--check` to seeing
// each damage, exiting non-zero on it, and writing nothing.
check("the read model's rebuild reproduces it on its business keys and not its build time",
      runsCheck("event-work-week-rebuild.ts"));
// AC-8.1 is the decision a person owns: which read model exists and why,
// what a page may cost, and the plain view and the materialized view refused by four mechanisms each —
// with the false claim that autovacuum ignores a materialized view denied rather than merely left out.
check("the seam between a page and the tables is decided, and a view and a materialized view are refused by their mechanisms",
      runsCheck("architecture-seams.ts"));
// The index each of four filters needs is written once in this check, held against both
// `schema-target/` and the migrated catalog, then planned on a throwaway seeded for it; and
// `zz.model_call` is held to the decision that retired both of its legacy indexes.
check("four recurring filters are served by an index both sides declare and a plan chooses, and zz.model_call keeps only the ts index a plan reaches",
      runsCheck("answer-indexes.ts"));
// Rule 9's general enforcement is `comment-completeness.ts`; this is
// the five things that are `zz.doc_revision`'s alone — the two constraints that refuse a referenced
// revision's deletion, the `doc_link` cascade that does not, the document cascade that does, that no
// sweep runs, and what reopens it — held against the target, the migrated catalog and the tree.
check("an unbounded table says what happens to it, in terms its schema and its code both keep",
      runsCheck("table-retention.ts"));
// `event-work-week-columns.ts` holds the register's six rows to their
// fields; this holds every class — the register's six, the settings reads, and the four stranded by
// an event write — to a range, a grain and a two-number budget, each evidenced at today's data and
// at ten times it, with buffers named as the second half of the evidence.
check("every console answer class states its range, its grain and a budget it can be held to at ten times the traffic",
      runsCheck("answer-budgets.ts"));
// `TableTarget` has no `reloptions` field, so the migration is the only
// place a per-table setting exists and `pg_class.reloptions` is the only place it is true; the second
// arm reads the heap fetches the covering index's index-only scan pays, before and after the vacuum
// the settings schedule, on a load this check states rather than describes.
check("an index-only scan's heap fetches are bounded by a vacuum schedule the table carries itself",
      runsCheck("event-autovacuum.ts"));
// `zz.doc` keeps no second copy of a document's bytes: the column is gone, the trigram index
// answers from the revision table, the statements that read it still answer, search reads the CURRENT revision and no other in an English, a
// Chinese and a mixed query, and the plan explained is the shipped statement's, naming the index.
check("a document's bytes have one home, the index that finds them lives there too, and search reads only the current revision",
      runsCheck("doc-body-drop.ts"));
check("no initiative reader derives closed, outcome or flow from zz.doc", runsCheck("initiative-lifecycle-readers.ts"));
check("every tool the spec renamed resolves through one frozen map", runsCheck("alias-maps.ts"));
check("no statement in the write trees names a table or column the migration retires",
      runsCheck("dropped-columns.ts"));
// `catalog-eval-columns.ts`, registered below, reads whether a statement can still be read once the
// migration lands; these two ask whether a row can still be written and whether a release identity
// is ever rewritten.
check("no insert under the write trees names a catalog table or column the phase retires",
      runsCheck("skill-row-shape.ts"));
check("a released plugin_version is written once, and no statement updates it",
      runsCheck("plugin-version-immutable.ts"));
check("a failure mode is an identity and a discovery of it is a sighting: identified by (plugin_id, stable_key), carrying its own prevalence, owner and evidence, and always resolving to a mode",
      runsCheck("failure-mode-identity.ts"));
check("a scored run is terminal: evaluation_score refuses it under a new key before any work, the key that scored it replays, the write lands only on an unscored run, and every result row names who produced it",
      runsCheck("scored-run-terminal.ts"));
check("an assessment names what it judged by kind and by exactly one child key, and the ledger keys on the principal's id",
      runsCheck("typed-subject.ts"));
// `eval-family-readers.ts` reads the same statements against the target and then plans them against
// a throwaway database migrated from this tree, counting the ones it cannot read rather than
// passing them.
check("no statement under the write trees names a catalog table or column the phase-3 migration retires",
      runsCheck("catalog-eval-columns.ts"));
check("every evaluation reader names a table and column the phase-3 migration leaves standing, and one it cannot read is counted rather than passed",
      runsCheck("eval-family-readers.ts"));
// `improve-control-shape.ts` reads the target's declared `uniques` and `foreignKeys` for the keys
// group G names, rather than matching a migration's text.
check("the improve and control tables hold group G's shape, and the keys it names are the target's own",
      runsCheck("improve-control-shape.ts"));
check("a fact of a governed run is identified inside its run, and a revision withdraws exactly the approval it replaced",
      runsCheck("control-evidence-identity.ts"));
check("the improve and promote ledgers' relations are tables, and no file names a column the reshape retires",
      runsCheck("release-relations.ts"));
check("eval_finding holds one lifecycle, and a strength carries no decision",
      runsCheck("finding-one-lifecycle.ts"));
// `artifact-layer-removed.ts`: the target declares none of the artifact/search
// tables, `knowledge_node` is the spec's fifteen columns, and the two trigram indexes are
// declared on it and on `doc`.
check("the artifact and search tables are gone, knowledge_node is the spec's shape, and Chinese retrieval has its index",
      runsCheck("artifact-layer-removed.ts"));
// `knowledge-node-ids.ts`: no statement names the retired text relations, and each
// of `team_id`, `node_ordinal`, `slug` and `superseded_by_id` has a writer.
check("knowledge_node's writers and readers answer from the ids, and the evidence relation is written and read",
      runsCheck("knowledge-node-ids.ts"));
// `han-retrieval.ts`: the Han clause is still a substring match, and the Han half of
// `body_tsv` is read rather than left write-only. Its `run:` half is the EXPLAIN that shows
// the trigram index serving the predicate, which `text-search-config-agreement.ts` proves by
// running the scoring assembly rather than by a textual proxy.
check("Chinese retrieval still matches as a substring, and the Han half its index needs is read rather than left write-only",
      runsCheck("han-retrieval.ts"));
check("a person finds their own document or lesson by the number-like part of a hyphenated word, and every search that worked before still does, an exact word, a phrase, a Han substring, a version, a compound whole and by part and a title above a body, while a row with no such word keeps its vector and a boot re-derives rows of the previous generation, through a real zz-core on a throwaway database",
      runsCheck("knowledge-search-hyphen-parts.ts"));
check("an empty knowledge_search names superseded lessons that match, says when its filters select no row instead of blaming the query, and a Han query finds a Han lesson, through a real zz-core on a throwaway database",
      runsCheck("knowledge-search-empty-cause.ts"));

check("the resolvers are applied wherever a stored name is read", runsCheck("alias-applied.ts"));

check("a column nothing reads is not proof a column nothing needs", runsCheck("tool-key-read.ts"));

check("an insert names as many values as it names columns",
      runsCheck("insert-arity.ts"));

check("a query binds as many parameters as its statement names",
      runsCheck("query-arity.ts"));

check("one live token per purpose, on every writer of a platform access token",
      runsCheck("pat-one-live-per-label.ts"));

check("an authorization code is stored as its hash and spent exactly once",
      runsCheck("oauth-code-consumed.ts"));

check("every authorization response names its issuer, as the metadata promises",
      runsCheck("oauth-issuer-bound.ts"));

check("the definition this platform is built on holds in its source",
      runsCheck("definition-rules.ts"));

check("the record's own columns exist, and a gap is nullable", runsCheck("record-and-cost-columns.ts"));

check("every tool call says which plugin it was made for", runsCheck("attribution.ts"));

check("what a call cost is a column, and detail keeps no second copy",
      runsCheck("telemetry-columns.ts"));

check("a call's origin is one rule: three maintenance clients are platform, every other name is work",
      runsCheck("event-origin.ts"));

check("the chain check runs where a deployment exists, and not in this gate",
      runsCheck("chain-check-wiring.ts"));

check("every completion the judge asks for is recorded, a 200 that is not JSON included, an unreported figure stays null, and only a 429 or a quota answer is reported as quota",
      runsCheck("judge-usage.ts"));

// The document store's shape, asserted on the target — `doc_revision` and `doc_link` in the spec's
// shape and `doc` carrying its new keys, with the current-revision key deferrable by column name —
// because the target is what the migration is written to match.
check("the document store is declared: two new tables, and doc's new identity keys",
      runsCheck("store-shape.ts"));

// The document tools are off the store's write path: none of their files calls `commitStore` or
// `indexDoc`, matched on call sites rather than on declarations, plus that the two document tools read the revision table, that none writes a
// document with the raw primitive.
check("the document tools read and write the database, not the file store",
      runsCheck("no-file-store.ts"));

// A non-owned subject is written up without its patch ever being applied: `proposal-doc.ts` imports
// nothing that can run anything and renders the diff fenced. Matched on code, with comments stripped.
check("a proposal is written up without its patch ever being applied",
      runsCheck("proposal-never-executes.ts"));

// Every remaining store reader and writer is off it: a negative about the whole tree — that no tracked file under `services/` or `packages/` CALLS `commitStore`,
// `indexDoc`, `persistDocument` or `logActivity`, with no file exempt — and that the two AC-6.7 pins are written where the writers live. A negative is easy to
// satisfy by renaming, so it matches call SITES.
check("every remaining store reader and writer reads and writes the database",
      runsCheck("store-unreached.ts"));

// The envelope's open payload: it asserts the target's declaration, the
// migration's `ADD COLUMN`, the writer's residual rule and the columns-win statement, and the
// backfill's store-reading fill — the two halves of the rule that keep `doc_revision.fields` from
// becoming a second home for a fact that has a column.
check("a document's envelope has a home: the revision's open payload, and the columns win over it",
      runsCheck("envelope-fields.ts"));

// The drop and the target agree with each other. `schema-inventory` compares a
// live catalog against the target, so a migration without its target entry and a target without
// its migration are each red on their own — neither file states the property that they match, and
// this does. It also asserts the layer is gone and that the backup stopped copying the store.
check("doc's retired columns are dropped, and the target says so",
      runsCheck("drop-is-complete.ts"));
check("the store is retired: its layer, its paths, and its backup", runsCheck("store-retired.ts"));

// The inventory check compares comments entry for entry against the target; this asserts the property
// no per-table comparison can state — that nothing across the whole schema is missing one.
check("every table and column carries its structured comment",
      runsCheck("comment-completeness.ts"));

// The first reads a release's record from each shape the changelog has; the second
// records releases on a throwaway database (Docker; exit 2 without it) and reads every tagged
// section of CHANGELOG.md.
check("a release's record reads its summary, upgrade notes, client action and console version from its own changelog section, and a tag with no section is No changelog entry with its action unknown, never nothing to do",
      runsCheck("release-record.ts"));
check("a release is recorded once at its first time, a conflicting record is reported and changes nothing, the backfill writes one row per tag and reconciles the count, a release whose row failed to write names `node scripts/release-record.ts --record <version>`, which writes every missing row once while `--correct` refuses a version with none, and every tagged section of this changelog yields a summary, on a throwaway database",
      runsCheck("release-record-db.ts"));
check("the SQL readers read code as code: a helper whose parameters destructure folds to its whole statement, and only a .query( in code is a call site, its escapes kept", runsCheck("sql-scanners.ts"));
check("watch-results alerts on a refusal class read from the refusal column, and tool-report --actor selects one address's calls by the gateway's own caller hash, on a throwaway database", runsCheck("ops-readers-live.ts"));
check("a team's rebuild re-derives every stale row of that team across pages and no other team's, naming a row it cannot re-derive and going on, and the every-team walk resumes from its watermark, on a throwaway database", runsCheck("reindex-walk.ts"));
check("chain-check records a refusal where its walk expects JSON as a FAILED line and still ends on its summary", runsCheck("chain-check-refusals.ts"));
