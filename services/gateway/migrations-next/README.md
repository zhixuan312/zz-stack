# Migrations that are written, tested, and deliberately not applied yet

`services/gateway/src/db.ts` scans `migrations/` for `*.sql` and applies what it has not seen.
This directory is not that one, so nothing here runs.

A migration sits here when it is correct but the code that reads those columns has not moved yet.
Applying it early would not corrupt anything — it would make the platform answer errors, which is
worse, because the store keeps working and only the queries fail.

This is release sequencing, not a compatibility shim. There is no branch anywhere choosing between
the old shape and the new one, no flag, and no adapter. The end state is exactly what these files
produce; they are simply not the first thing to land.

## 022_drop_denormalized.sql

Removes the seventeen denormalized columns that 016-020 made redundant. Tested end to end against
a copy of the live database: all six migrations apply clean, 5,487 events keep their attribution
through `run_id`, 140 documents resolve to the skill version that produced them, and `zz.event`
comes out as `id, ts, actor, kind, subject, detail, ok, refusal, run_id, block_version_id,
team_id`.

**The `event_bytes` index in this file was changed after that end-to-end test, and the test has
not been re-run over it.** It indexed `(detail->>'bytes')::bigint`; migration 050 moved that
figure into the real column `response_bytes` and the gateway stopped writing the bag key, so the
expression would have indexed only pre-050 history. It is now `(response_bytes desc) where
response_bytes is not null`. Nothing else in this file was touched, and 050 is applied ahead of
it, so the column exists by the time this runs — but the sentence above about a clean end-to-end
apply predates the edit, and should not be read as covering it.

**Everything that must land with it** — all of it, or the platform answers errors:

    services/zz-core/src/indexing.ts
      indexDoc          write initiative_id + produced_by_run_id, not team_slug/initiative/flow
      indexDoc          write zz.decision_block, not decision.blocks / decision.block_versions
      reindexTeam       delete through initiative_id; never touch initiative, run, event, eval_*

    services/zz-core/src/tools/knowledge.ts
      search_knowledge  read through initiative
      recall            read through initiative

    services/zz-core/src/tools/initiative-status.ts
      reconcile         join zz.decision_block, not the text[]

    services/gateway/src/events.ts     write team_id / run_id / block_version_id
    services/gateway/src/step-trace.ts open a zz.run row, inject its id as a header
    services/gateway/src/kb.ts         read through initiative

    packages/tools/src/testing/{step-score,tool-report,flow-compare}.ts
    packages/tools/src/ops/watch-results.ts

Move the file into `migrations/` in the same change that lands those. Do not split it further:
the columns have to go all at once, because a reader that finds both shapes present will pick one
and be silently wrong about the other.

## 021_delegated_tokens.sql — LANDED, and this section is what it left behind

This directory used to carry a long description of the delegated-token work as staged and
blocked: two tables, two routes, a `block-oauth.ts.staged` module held back "on request", and a
blocker about a client whose `redirect_uris` was empty.

**It shipped.** `migrations/021_delegated_tokens.sql` is applied, `zz.block_token` and
`zz.block_oauth_state` are on the live database, and `services/gateway/src/block-oauth.ts`
serves the callback. There is no `.staged` file anywhere in the tree.

Kept as one paragraph rather than deleted, because a directory whose whole purpose is "do not
forget these" is the worst place to describe finished work as pending — the next person to read
it goes looking for a file that is not there, and trusts the rest of the page less for it.

## 057_drop_third_party_blocks.sql

Removes the third-party-server layer: `zz.tool_grant`, `zz.block_token`,
`zz.block_oauth_state`, `zz.decision_block`, and the `zz.event.block` /
`zz.doc.blocks` / `zz.decision.blocks` columns. Measured against production before it was
written, all time, platform-wide: **every one of them is empty** — 0 grants, 0 tokens,
0 oauth states, 0 decision_block rows, 0 events naming a block, 0 documents and 0 decisions
with a non-empty blocks array. Nothing is lost.

Tested end to end against a restored copy of the live database: it applies clean, the four
tables and three columns are gone, and 7,009 events, 1,744 documents, 541 decisions and the
926 `zz.block_tool` rows all survive untouched.

**Everything that must land with it** — all of it, or the gateway answers errors:

- `services/gateway/src/blocks.ts` and the `PLATFORMS` registry it parses
- `services/gateway/src/block-oauth.ts` and the `/p/<block>/mcp` proxy route
- the `/manage` door's `block_connect`, `block_disconnect`, `tool_grant`, `tool_revoke`,
  `credential_set`, `credential_list`, `credential_delete`, `platform_list` tools
- `packages/contracts`' `PlatformMap`
- the console's "Blocks granted" and "Block connections" panels and the Teams table's
  Blocks column
- the `zz-access` and `zz-admin` skills' building-block sections, and the marketplace
  rebuilt from them

**It does NOT touch `zz.block` / `zz.block_version` / `zz.block_tool`.** Those are a
different subject wearing the same word: the platform's own tool surface per release, one
row named `platform` titled `zz-core`, 32 versions, 926 tools. `zz.plugin` already holds
that same subject as `zz-core` with 15 versions — the platform is registered twice, in two
models, and the block half is the older one. Folding them is a data move (926 rows need a
`plugin_tool` to land in, and `zz.skill.block_id` plus every skill still carrying
`kind = 'block_usage'` repoints as it goes), so it gets its own migration and its own
end-to-end test rather than riding behind seven drops.

## 059_knowledge_is_its_own_subject.sql

Moves the 853 knowledge nodes out of `zz.doc` into `zz.knowledge_node`, and renames their
`status` to `lifecycle` — because `approved` means a person agreed and `adopted` means this is
the best we currently know, and one column cannot answer both. Six columns do not come with
them: a node has never had a flow, an outcome, an approver, an approval time, a closing actor
or a supported document, 0 of 853 for each.

Proven against a copy of production inside a transaction that rolled back: 853 moved, 0 nodes
left in `zz.doc`, 378 rows remaining there, every node's evidence carried, both lifecycles and
all six kinds preserved.

It waits on three readers: `indexDoc` still writes a node into `zz.doc`, `knowledge_search`
reads it there, and the console's knowledge routes join it. Applying it first would empty the
index without emptying the store — a search would answer "nothing is known" about 853 nodes
that are on disk, which is the silent failure this directory exists to prevent.
