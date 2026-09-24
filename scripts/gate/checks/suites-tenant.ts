/**
 * Tenant information: the record, its retrieval, and the evidence a release needs — the
 * artifact kernel and its hashes, the corpus and lane arithmetic, the analyzer, the migration
 * and its losslessness, the benchmark and acceptance reports.
 */
import { check } from "../run.ts";
import { runsCheck } from "../suite-runner.ts";

check("tenant-info's workspace and suite guards refuse what they say they refuse, and its CLI carries no import-time side effects",
      runsCheck("tenant-info-cli.ts"));

check("a baseline receipt carries every required field with its measurement evidence, and never a credential",
      runsCheck("tenant-info-baseline-fields.ts"));

check("corpus planning arithmetic refuses a fractional fixture count, and the deterministic text generator hits its exact byte target",
      runsCheck("tenant-info-corpus-shape.ts"));

check("the judged dataset holds its exact category/language/split counts, no family leaks across dev and held-out, and every qrel resolves to an existing query and an authorized fixture ref",
      runsCheck("tenant-info-qrels-integrity.ts"));

check("the PostgreSQL 17 lock, Dockerfile and config agree on the pinned major/patch, base digest, pg_textsearch release and actual preload membership",
      runsCheck("postgres-image-pinned.ts"));

check("a backup manifest is refused when it is missing any of the five undisposable component kinds, when the canonical record is not included, or when a component's hash is malformed",
      runsCheck("backup-covers-the-undisposable.ts"));

check("the artifact reference and semantic payload schemas reject malformed input and agree on the one semantic-field order",
      runsCheck("tenant-information-contract.ts"));

check("a commit manifest hashes over its own canonical fields, never over bytes containing that hash, and a commit's basename refuses a non-positive sequence",
      runsCheck("tenant-record-durability.ts"));

check("a mutation request hashes canonically regardless of key order, changes with its payload or expected_etag, and a commit outcome classifies to true/false/unknown exactly as the spec's publication/durability table says",
      runsCheck("tenant-kernel-codes.ts"));

check("a semantic payload's canonical hash is stable under tag order/dupes, CRLF and sorted content_fields, and changes on every single-field edit the spec names",
      runsCheck("tenant-revision-boundary.ts"));

check("a subtype policy decision refuses source verify, knowledge approve and an undeclared work gate by name, and binds approval/verification to the actual revision and record digest",
      runsCheck("tenant-lifecycle-matrix.ts"));

check("the adapter fixture's patch/approve enter the one mutation kernel — a missing etag, a stale retry and a stale approval are each refused, an idempotent replay returns the original transaction, and the materialized read reflects exactly the committed edit",
      runsCheck("tenant-single-writer.ts"));

check("an OKF round trip through the real YAML parser keeps unknown keys, never turns verified_against into a fabricated verification event, and OKF conformance and native-profile validation report separate verdicts",
      runsCheck("okf-round-trip.ts"));

check("the actual migrations directory names the migration slug exactly once, every numeric prefix is unique, and a duplicate or missing slug is refused",
      runsCheck("tenant-migration-shape.ts"));

check("a legacy import through the real importer and the real kernel keeps every original byte, classifies malformed frontmatter as legacy-raw, leaves an undeclared original time null, and applying the same conversion manifest twice adds no identity, revision or event",
      runsCheck("tenant-migration-losslessness.ts"));

check("bounded overlapping passages cover every UTF-8 byte with no truncation at any size, identifier analysis keeps exact spellings alongside derived lowercase parts, and a derivation fingerprint changes independently on every one of its named fields",
      runsCheck("tenant-complete-text.ts"));

check("the text analyzer handles empty text, CRLF, a forced long-token split with no whitespace to prefer, a full 1-MiB mixed-language body and a phrase at a passage boundary, and the 8-MiB kernel gate refuses new input while preserving legacy larger content",
      runsCheck("tenant-passage-analysis.ts"));

check("a migration needing an extension declares it, and the runner still defers rather than taking the database down", runsCheck("migration-extension-declared.ts"));

check("the rebuild cache decision is exact equality, refuses no prior attempt as always stale, and changes on every one of a fingerprint's own named fields",
      runsCheck("tenant-rebuild-inputs.ts"));

check("corpus resolution defaults to current, admits an explicit scope union, drops shared corpora when sharing is disallowed, and refuses an empty scope, an unknown scope or a caller-supplied owner/index override",
      runsCheck("tenant-scope-predicates.ts"));

check("lane budgets are fixed functions of the limit that refuse a non-integer or out-of-range value, RRF sums each lane's max-over-corpora contribution in a fixed lane order regardless of input order, and result-key identity is owner-qualified with history alone carrying revision/hash",
      runsCheck("tenant-fusion-arithmetic.ts"));

check("grammar recognition precedes identifier normalization so a quoted phrase, an OR alternative and a leading exclusion survive intact, an unterminated natural-mode quote refuses by position while websearch tolerates it, and the actual serialized response stays within 24000 UTF-8 bytes with disclosed truncation",
      runsCheck("tenant-query-syntax.ts"));

check("an isolation observation is refused as vacuous with no baseline results, and refused on a changed statistic, a changed score or leaked forbidden metadata, never only on a mismatched shape",
      runsCheck("tenant-isolation-statistics.ts"));

check("the acceptance profile blocks a suite on a case that never ran and on a receipt it cannot read case by case, leaves the integration profile unchanged, and keeps a block distinct from a failure",
      runsCheck("acceptance-profile-refuses-unrun-cases.ts"));

check("new artifact text over 8 MiB is refused through the real adapter with PAYLOAD_TOO_LARGE, the stored content is untouched, and an under-limit write still commits",
      runsCheck("payload-too-large-is-refused.ts"));

check("every one of the eighteen release targets is evaluated in its own direction, and a missing observation is blocked rather than zero",
      runsCheck("benchmark-report-completeness.ts"));

check("a benchmark report is refused when its scale is forged, its corpus distribution is off, a slice divides by nothing, its qrels are not the approved ones or a binding is missing — and the honestly empty report still validates",
      runsCheck("benchmark-report-fixtures.ts"));

check("gate-launch classification reads the syntax — a spawner named in a comment, a string or a regex literal is not a launch, and an aliased or namespaced one still is",
      runsCheck("tenant-checks-registered.ts"));

// DELIBERATE: the ordinary gate never reads the actual acceptance report. `assessAcceptance`
// runs here over synthetic observations, so this proves only that the decision function
// refuses the eight shapes of bad report — never that a delivery is ready. The real report is
// assembled, hashed and judged by `verify --finalize`, outside this gate, so that a gate can
// never depend on its own final verdict.
check("the acceptance decision needs all thirteen criteria, the spec's own method for each, a matching binding, verified evidence and a gate that actually executed — and a wholly failed report is still structurally valid",
      runsCheck("acceptance-covers-every-criterion.ts"));
