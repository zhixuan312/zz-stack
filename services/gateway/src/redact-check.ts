/**
 * Prove that redact() drives every settings response shape (← Task I-12, AC-4) to the same
 * outcome: no credential value and no stored token survives, including
 * nested in arrays or objects, while non-secret metadata — which block, when it was set, by
 * whom, a label, an id, a scope, a team, an expiry, a last-used timestamp — does survive.
 *
 *   npm run check:redaction      # exits non-zero on failure, like every engine here
 *
 * Every CASE below is a settings shape modelled on a REAL tool response in server.ts —
 * my_credentials, set_my_credential, set_team_credential, admin_set_credential,
 * delete_my_credential, my_access_tokens, issue_my_access_token, my_client_setup. Each
 * case names the secret values it plants and the metadata it expects
 * back untouched, and `check()` asserts both against the REAL `redact`, driven through the
 * REAL `looksSecret`/`SECRET_NAME_PARTS` field rule exported from redact.ts — never a copy
 * of either.
 *
 * Two things a reading of redact.ts cannot show on its own: that the field rule really does
 * fail CLOSED on a field nobody enumerated (Case "a field nobody named yet"), and that the
 * marker it produces cannot be turned back into the value it replaced (Case "the marker
 * survives the value it stood in for", which fingerprints the SAME secret twice and asserts
 * equal markers, then a DIFFERENT secret and asserts unequal ones — the property that makes
 * "still the same secret as before" answerable without the marker being a partial reveal).
 */
import { looksSecret, redact, SECRET_NAME_PARTS, type RedactedMarker } from "./redact.js";

/** True if `needle` appears anywhere in `value`'s JSON form — the direct test that a secret
 *  did not survive redaction in ANY position, nested or not. Buffers/Dates round-trip through
 *  JSON.stringify as plain data (`{"type":"Buffer",...}` / an ISO string) with nothing secret
 *  in either, so this is safe to run over the whole redacted tree unconditionally. */
function containsRaw(value: unknown, needle: string): boolean {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? String(v) : v)).includes(needle);
}

/** Read a dotted/indexed path (`"rows.0.label"`) out of a redacted structure — used to assert
 *  a specific piece of metadata survived exactly, at the position the real tool would put it. */
function at(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, seg) => {
    if (acc === null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[seg];
  }, value);
}

function isMarker(value: unknown): value is RedactedMarker {
  return typeof value === "object" && value !== null && (value as { redacted?: unknown }).redacted === true;
}

interface Case {
  name: string;
  /** Built fresh per case (some plant a Buffer, a Date, or a self-reference) rather than a
   *  shared literal any one case could mutate for the next. */
  build: () => unknown;
  /** Secret values that must not survive anywhere in the redacted output, in any form. */
  secrets: string[];
  /** Paths into the redacted output whose value must equal the same path in the input,
   *  unchanged — the metadata half of AC-4 that a secrets-only test would miss entirely. */
  metadataPaths: string[];
  /** Paths that must come back as a RedactedMarker with the given `present`. */
  redactedPaths: Array<{ path: string; present: boolean }>;
  why: string;
}

const ALICE = "alice@example.com";
const ROOT = "root@example.com";

const CASES: Case[] = [
  {
    name: "my_credentials — a list of platforms, each with a live personal key",
    build: () => [
      { platform: "github", api_key: "ghp_1234567890abcdefGHJK", set_at: "2026-01-01T00:00:00Z", set_by: ALICE },
      { platform: "gitlab", api_key: "glpat-zzzzzzzzzzzzzzzzzzzz", set_at: "2026-02-02T00:00:00Z", set_by: ALICE },
    ],
    secrets: ["ghp_1234567890abcdefGHJK", "glpat-zzzzzzzzzzzzzzzzzzzz"],
    metadataPaths: ["0.platform", "0.set_at", "0.set_by", "1.platform", "1.set_at", "1.set_by"],
    redactedPaths: [{ path: "0.api_key", present: true }, { path: "1.api_key", present: true }],
    why: "which platform, when it was set and by whom are exactly what the page needs to " +
         "show; the key itself is exactly what it must never receive",
  },
  {
    name: "set_my_credential — echoes the key just stored and the one it replaced",
    build: () => ({
      platform: "github", stored: true,
      key: "ghp_brandnewvalue00000001", replaced_key: "ghp_oldvalue000000000002",
      set_by: ALICE, set_at: "2026-03-01T00:00:00Z",
    }),
    secrets: ["ghp_brandnewvalue00000001", "ghp_oldvalue000000000002"],
    metadataPaths: ["platform", "stored", "set_by", "set_at"],
    redactedPaths: [{ path: "key", present: true }, { path: "replaced_key", present: true }],
    why: "server.ts's own set_my_credential answer names the replaced key so an overwrite " +
         "is not silent — both the new and the replaced value must be caught, not only the " +
         "field literally named 'key'",
  },
  {
    name: "set_team_credential / admin_set_credential — team-scoped, admin-set",
    build: () => ({
      team: "team_one", platform: "openai", api_key: "sk-liveabcdefghijklmno",
      set_by: ROOT, set_at: "2026-03-02T00:00:00Z",
    }),
    secrets: ["sk-liveabcdefghijklmno"],
    metadataPaths: ["team", "platform", "set_by", "set_at"],
    redactedPaths: [{ path: "api_key", present: true }],
    why: "an admin acting for someone else must not change what survives — team and " +
         "operator identity are metadata regardless of who made the call",
  },
  {
    name: "delete_my_credential — no secret in the response at all",
    build: () => ({ platform: "github", deleted: true, deleted_by: ALICE, deleted_at: "2026-03-03T00:00:00Z" }),
    secrets: [],
    metadataPaths: ["platform", "deleted", "deleted_by", "deleted_at"],
    redactedPaths: [],
    why: "a redactor that mangles a shape with nothing to redact would be as unusable as one " +
         "that leaks — this proves the pass-through path changes nothing",
  },
  {
    name: "my_access_tokens / list_pats — PAT rows, plus a field nobody named yet",
    build: () => [
      { id: "11111111-1111-1111-1111-111111111111", label: "laptop", scope: "member",
        team: null, created_at: "2026-01-01T00:00:00Z", last_used_at: null, revoked_at: null },
      { id: "22222222-2222-2222-2222-222222222222", label: "ci", scope: "member",
        team: "team_one", created_at: "2026-01-02T00:00:00Z",
        last_used_at: "2026-02-01T00:00:00Z", revoked_at: "2026-02-15T00:00:00Z",
        // list_pats's real query never selects this — but nothing in the TYPE SYSTEM stops
        // a future column from being added to the select list without anyone deciding
        // whether it is safe to show. That is exactly the case this file exists to prove:
        // the field rule catches it on NAME alone, with no update to redact.ts required.
        token_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b8" },
    ],
    secrets: ["e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b8"],
    metadataPaths: [
      "0.id", "0.label", "0.scope", "0.team", "0.created_at", "0.last_used_at", "0.revoked_at",
      "1.id", "1.label", "1.scope", "1.team", "1.created_at", "1.last_used_at", "1.revoked_at",
    ],
    redactedPaths: [{ path: "1.token_hash", present: true }],
    why: "list_pats and my_access_tokens never select a hash today, but a check that only " +
         "drove today's exact query would still pass the day someone adds one without " +
         "deciding — this is the fail-closed property, exercised rather than asserted",
  },
  {
    name: "issue_my_access_token's shape, run through redact anyway",
    build: () => ({ token: "zzpat_live_abcdefghijklmnopqrstuvwxyz", label: "laptop", email: ALICE }),
    secrets: ["zzpat_live_abcdefghijklmnopqrstuvwxyz"],
    metadataPaths: ["label", "email"],
    redactedPaths: [{ path: "token", present: true }],
    why: "this is the ONE exception the contract carries, and it is not a special case in " +
         "redact() at all — it is proven here by showing redact() does NOT recognise the " +
         "exemption: the freshly issued token is redacted like any other, exactly like " +
         "every other secret-named field. The exemption can only ever live in the issuing " +
         "route choosing not to call redact() on this one payload — there is no flag here " +
         "for it to have used instead",
  },
  {
    name: "my_client_setup — a live bearer token nested three levels deep in client config",
    build: () => ({
      mcpServers: {
        "zz-gateway": {
          url: "https://gw.example.com/manage/mcp",
          headers: { Authorization: "Bearer zzpat_configuredabcdefghijk" },
        },
      },
    }),
    secrets: ["zzpat_configuredabcdefghijk"],
    metadataPaths: ["mcpServers.zz-gateway.url"],
    redactedPaths: [{ path: "mcpServers.zz-gateway.headers.Authorization", present: true }],
    why: "a client config is the deepest nesting any of these tools produce — the field " +
         "rule has to reach a header value three objects down exactly as reliably as a " +
         "top-level one",
  },
  {
    name: "empty and absent secrets read as 'not present', not as a leak of length zero vs missing",
    build: () => ({ platform: "github", api_key: "", nickname: null, count: 0, active: true, label: "x" }),
    secrets: [],
    metadataPaths: ["platform", "nickname", "count", "active", "label"],
    redactedPaths: [{ path: "api_key", present: false }],
    why: "an empty stored key and a null non-secret field are different facts — 'nothing is " +
         "stored' must come back as present:false, not silently drop the field or throw",
  },
];

/** A settings response can legitimately hold a Date the database returned uncast, or a
 *  Buffer for a binary secret — checked structurally rather than by JSON round-trip, since
 *  the whole point is confirming the ORIGINAL objects/bytes come back untouched or replaced,
 *  which JSON.stringify would already have destroyed before the assertion ran. */
function checkDatesAndBuffers(): string[] {
  const failures: string[] = [];
  const createdAt = new Date("2026-04-01T00:00:00Z");
  const secretBytes = Buffer.from("hunter2-raw-secret-bytes", "utf8");
  const input = { created_at: createdAt, client_secret: secretBytes, label: "x" };
  const got = redact(input) as { created_at: unknown; client_secret: unknown; label: unknown };

  if (got.created_at !== createdAt) {
    failures.push("a Date under a non-secret field name did not survive as the same Date instance");
  }
  if (got.label !== "x") failures.push("a plain string under a non-secret field did not survive");
  if (!isMarker(got.client_secret)) {
    failures.push("a Buffer under a secret-named field was not redacted at all");
  } else {
    const marker = got.client_secret;
    if (!marker.present) failures.push("a non-empty Buffer redacted as present:false");
    if (marker.length !== secretBytes.length) {
      failures.push(`Buffer marker length was ${marker.length}, expected ${secretBytes.length}`);
    }
    if (!marker.fingerprint || marker.fingerprint.includes("hunter2")) {
      failures.push("Buffer marker's fingerprint is missing or leaks the original bytes");
    }
  }
  if (containsRaw(got, "hunter2")) failures.push("the raw Buffer content survived redaction somewhere in the output");
  return failures;
}

/** Two structurally different cycles: an object referencing itself directly, and one two
 *  levels of nesting away, each also carrying a live secret — a cycle must not hang the
 *  process AND must not give the secret walker an excuse to skip the field rule on the rest
 *  of the structure. */
function checkCircularReferences(): string[] {
  const failures: string[] = [];

  const direct: Record<string, unknown> = { team: "team_one", api_key: "sk-cycletest0001", label: "direct" };
  direct.self = direct;
  const gotDirect = redact(direct) as Record<string, unknown>;
  if (gotDirect.self !== "[Circular]") failures.push(`a direct self-reference came back as ${JSON.stringify(gotDirect.self)}, expected "[Circular]"`);
  if (!isMarker(gotDirect.api_key)) failures.push("a secret survived on an object that also contains a direct cycle");
  if (gotDirect.team !== "team_one" || gotDirect.label !== "direct") failures.push("metadata was lost on an object that also contains a direct cycle");

  const arr: unknown[] = ["a", "b"];
  const nested: Record<string, unknown> = { platform: "github", api_key: "sk-cycletest0002", items: arr };
  arr.push(nested);
  const gotNested = redact(nested) as Record<string, unknown>;
  const items = gotNested.items as unknown[];
  if (items[2] !== "[Circular]") failures.push(`an array cycling back to its owning object came back as ${JSON.stringify(items[2])}, expected "[Circular]"`);
  if (items[0] !== "a" || items[1] !== "b") failures.push("array elements before the cycle were altered");
  if (!isMarker(gotNested.api_key)) failures.push("a secret survived on an object reachable through an array cycle");

  // A shared (non-cyclic) reference from two branches must still be redacted correctly in
  // BOTH places — proof that `seen` is scoped to the current path, not the whole call.
  const shared = { platform: "openai", api_key: "sk-shared00000001" };
  const twoBranches = { a: shared, b: shared };
  const gotShared = redact(twoBranches) as { a: { api_key: unknown }; b: { api_key: unknown } };
  if (!isMarker(gotShared.a.api_key) || !isMarker(gotShared.b.api_key)) {
    failures.push("a value reachable from two different branches (not a cycle) was not redacted on both paths");
  }

  return failures;
}

/** No field name at the root means no decision this function can make — documented in
 *  redact.ts's own doc comment as a deliberate limitation, checked here so the behaviour it
 *  promises does not silently change. */
function checkNoFieldNameAtRoot(): string[] {
  const failures: string[] = [];
  if (redact("ghp_bareStringNoFieldName") !== "ghp_bareStringNoFieldName") {
    failures.push("a bare string with no field name was altered — redact() should pass it through unchanged");
  }
  if (redact(null) !== null) failures.push("redact(null) did not return null");
  if (redact(undefined) !== undefined) failures.push("redact(undefined) did not return undefined");
  const arr = redact(["sk-bareArrayElement"]) as unknown[];
  if (arr[0] !== "sk-bareArrayElement") {
    failures.push("a bare secret-looking string as an array element with no owning field name was altered");
  }
  return failures;
}

/** The field rule itself (← the predicate redact-check.ts is required to drive directly,
 *  never a restatement of it), over every listed part and a handful of names it must NOT
 *  catch — metadata this whole module exists to keep visible. */
function checkFieldRule(): string[] {
  const failures: string[] = [];
  const mustCatch = [
    "token", "Token", "access_token", "refresh_token",
    "secret", "client_secret",
    "password", "password_verifier",
    "key", "api_key", "private_key",
    "credential", "credentials",
    "authorization", "Authorization",
    "verifier",
  ];
  for (const name of mustCatch) {
    if (!looksSecret(name)) failures.push(`looksSecret("${name}") is false — the field rule must catch it`);
  }
  const mustSurvive = ["platform", "team", "label", "id", "scope", "set_by", "set_at", "created_at", "last_used_at", "revoked_at", "email", "status", "expires_at"];
  for (const name of mustSurvive) {
    if (looksSecret(name)) failures.push(`looksSecret("${name}") is true — this is metadata the page must still show`);
  }
  if (!SECRET_NAME_PARTS.length) failures.push("SECRET_NAME_PARTS is empty — nothing would ever be redacted");
  return failures;
}

/** The marker cannot be turned back into the value — checked by the property that makes it
 *  USEFUL rather than merely opaque: the SAME secret fingerprints identically every time
 *  (so a caller can tell "this didn't change"), and two DIFFERENT secrets of the same length
 *  fingerprint differently (so the fingerprint isn't just an echo of the length). Neither
 *  fingerprint contains any substring of either secret. */
function checkMarkerCannotReconstructValue(): string[] {
  const failures: string[] = [];
  const secretA = "sk-repeatedvalue0000001";
  const secretB = "sk-repeatedvalue0000002";
  const m1 = redact({ api_key: secretA }) as { api_key: RedactedMarker };
  const m2 = redact({ api_key: secretA }) as { api_key: RedactedMarker };
  const m3 = redact({ api_key: secretB }) as { api_key: RedactedMarker };

  if (m1.api_key.fingerprint !== m2.api_key.fingerprint) {
    failures.push("the same secret fingerprinted differently on two separate redactions");
  }
  if (m1.api_key.fingerprint === m3.api_key.fingerprint) {
    failures.push("two different secrets of the same length produced the same fingerprint");
  }
  for (const [name, secret, marker] of [["A", secretA, m1.api_key], ["B", secretB, m3.api_key]] as const) {
    if (marker.fingerprint && (secret.includes(marker.fingerprint) || marker.fingerprint.includes(secret.slice(0, 4)) || marker.fingerprint.includes(secret.slice(-4)))) {
      failures.push(`secret ${name}'s fingerprint overlaps with the value it stands in for`);
    }
  }
  return failures;
}

function main(): number {
  const failures: string[] = [];

  for (const c of CASES) {
    let input: unknown;
    let got: unknown;
    try {
      input = c.build();
      got = redact(input);
    } catch (e) {
      failures.push(`${c.name}: redact() threw ${String(e)} — it must never throw — ${c.why}`);
      continue;
    }

    for (const secret of c.secrets) {
      if (containsRaw(got, secret)) {
        failures.push(`${c.name}: the raw secret "${secret.slice(0, 6)}…" survived redaction — ${c.why}`);
      }
    }
    for (const path of c.metadataPaths) {
      const wantVal = at(input, path);
      const gotVal = at(got, path);
      if (JSON.stringify(gotVal) !== JSON.stringify(wantVal)) {
        failures.push(`${c.name}: metadata at "${path}" changed — got ${JSON.stringify(gotVal)}, expected ${JSON.stringify(wantVal)} — ${c.why}`);
      }
    }
    for (const { path, present } of c.redactedPaths) {
      const gotVal = at(got, path);
      if (!isMarker(gotVal)) {
        failures.push(`${c.name}: "${path}" was not redacted at all (got ${JSON.stringify(gotVal)}) — ${c.why}`);
      } else if (gotVal.present !== present) {
        failures.push(`${c.name}: "${path}" redacted with present:${gotVal.present}, expected present:${present} — ${c.why}`);
      }
    }
  }

  failures.push(...checkDatesAndBuffers());
  failures.push(...checkCircularReferences());
  failures.push(...checkNoFieldNameAtRoot());
  failures.push(...checkFieldRule());
  failures.push(...checkMarkerCannotReconstructValue());

  if (failures.length) {
    console.error(`\n  redaction: ${failures.length} case(s) failed\n`);
    for (const f of failures) console.error(`    ${f}`);
    console.error("");
    return 1;
  }
  console.log(
    `  redaction: ${CASES.length} response-shape cases pass over the real redact()/looksSecret — ` +
    "no credential value, password verifier or stored token survives redaction anywhere in " +
    "a structure, nested or not, a field nobody named yet is still caught, non-secret " +
    "metadata survives unchanged, direct/nested/shared circular references neither hang nor " +
    "skip the field rule, Dates and Buffers pass through or redact correctly by field name, " +
    "and the marker cannot be used to reconstruct the value it replaced");
  return 0;
}

process.exit(main());
