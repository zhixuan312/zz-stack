-- WHICH DOOR A TOOL IS ON, because the surface record could not say and answered anyway.
--
-- zz.block_tool has been `(id, block_version_id, name, verdict, …)` since 016. A surface was
-- therefore a SET OF NAMES, and for one-door blocks that was the whole truth. It stopped being
-- the whole truth about US: zz-core serves two doors out of one process — `/mcp` and
-- `/eval-mcp`, published by the gateway as `/core/mcp` and `/eval/mcp` — and both fill the same
-- OWN_TOOLS before the surface is written.
--
-- ── WHY A COLUMN RATHER THAN A SHRUG ────────────────────────────────────────────────────
--
-- A surface report diffs one version's recorded surface against the version before it. Ten
-- `plugin_*` tools moved from the core door to the evaluation door in this initiative — the
-- largest change this platform's tool surface has ever had — and the recorded NAME SET before
-- and after is IDENTICAL. So the report answers NO CHANGE, confidently, about the change. That
-- is not a gap that reads as silence; it is a wrong answer wearing the shape of a right one,
-- and it is the same failure 049 removed a column for: an empty answer indistinguishable from
-- a true negative. Here it is worse, because the answer is not empty.
--
-- ── THE VOCABULARY IS THE GATEWAY'S, NOT A SECOND ONE INVENTED HERE ──────────────────────
--
-- The values written are the words `doorSurface()` (services/gateway/src/tool-telemetry.ts)
-- answers: `core`, `eval`, `manage`, or a block's own name. That is deliberate and it is the
-- reason this column is worth having twice over — `zz.event.tool_key` is the alias-resolved
-- `<surface>:<tool>`, written with exactly those words, so `door` joins to the left half of
-- every recorded call. "This tool moved to the evaluation door" and "these are the calls that
-- went through the evaluation door" become one query instead of two answers nobody can line up.
-- checks/eval-door.mjs asserts the two vocabularies are the same words by comparing what a
-- built door recorded against what `doorSurface()` returns, so this paragraph is a claim that
-- fails loudly rather than a hope.
--
-- NO CHECK CONSTRAINT, unlike `verdict` two columns above. `verdict` is a closed judgement with
-- three words this platform owns. A door name is OPEN: every building block contributes its own
-- name through `/p/<block>/mcp`, and a door added tomorrow is a legitimate value the day it is
-- mounted. A constraint listing today's doors would reject a row that is correct, on a column
-- whose whole purpose is to record what is actually there.
--
-- ── WHAT HAPPENS TO EXISTING ROWS: NOTHING. THEY STAY NULL, AND NULL IS AN ANSWER ────────
--
-- No backfill, no default. NULL here means "which door this tool was on was not recorded", and
-- it is the honest value for every row that exists today, in two distinct situations that are
-- both genuinely unknown:
--
--   1. Rows written for `platform` before this migration. The service that wrote them did not
--      know the door, so the door is not in them. It could be GUESSED — everything except the
--      ten `plugin_*` names was on the core door — and guessing is exactly what must not
--      happen: `recordOwnSurface` never rewrites a version's row, because the row means "this
--      is what that version served" and editing it makes the history agree with today by
--      construction. A backfill is that edit with a friendlier name, and a door recorded
--      confidently from a reconstruction is worse than an absent one — which is the same
--      argument this migration exists to make about NO CHANGE.
--
--   2. Rows written by `zz-tool refresh-block-tools` for somebody else's block. Those are
--      derived from the event log and the platform never learns a door for them; that op's
--      `on conflict … do update set` deliberately does NOT touch `door`, so a platform row it
--      ever collided with would keep the door the service recorded rather than have it wiped
--      by an annotation pass.
--
-- WHAT A READER DOES WITH NULL IS NOT "TREAT IT AS THE CORE DOOR". The surface report
-- (`zz-tool block-surface`) reports a name whose door is NULL on either side as door-unknown,
-- and a name that is NULL on one side and set on the other as "doors were not recorded for
-- <that version>" — never as a move. A version recorded before 052 can only ever be compared by
-- NAME, which is what it was recorded to support; the door comparison starts at the first
-- version recorded after this lands.
--
-- ON A DEPLOYMENT, THAT FIRST VERSION IS THE NEXT ONE. `recordOwnSurface` writes once per
-- service version and leaves an existing version's row alone, so the version already running
-- keeps NULL doors until the version number moves. The first door-to-door diff is therefore
-- available one release after this, not immediately, and the report says so rather than
-- showing an empty change list.

alter table zz.block_tool add column if not exists door text;

comment on column zz.block_tool.door is
  'Which door served this tool, in the gateway''s own surface vocabulary (core, eval, manage, '
  'or a block''s name) — the same words as the left half of zz.event.tool_key, so the recorded '
  'surface joins to the recorded calls. Null means the door was not recorded: every row written '
  'before migration 052, and every row derived by refresh-block-tools for a block we only probe. '
  'Null is NOT the core door and must never be read as one; a surface diff reports it as '
  'door-unknown rather than as a move.';
