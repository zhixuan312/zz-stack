-- THE ABLATION HALF OF PLUGIN EVALUATION IS REMOVED, DATA INCLUDED.
--
-- A `claude plugin eval` suite ran cases with the plugin and without it and reported the score
-- delta; `case_record` stored the run whole, and rulers drew thresholds over it.
--
-- IT NEVER MEASURED WHAT IT APPEARED TO. No case ever declared a mock, so under the CLI's
-- default `--mocks record` no plugin server started and the plugin's MCP tools were NOT
-- CALLABLE IN EITHER ARM. Every grader was a regex over tool NAMES or a judgement about an
-- answer's shape. A delta therefore established that the method's TEXT had reached the agent
-- and that it used the right words -- never that the plugin worked. The strongest result the
-- suite ever produced came from a prompt that typed the plugin's own command, which is a way
-- of asking whether text helps once you have already handed it over.
--
-- Nine cases across three plugins, several hundred dollars of one person's own credential, and
-- two of the four most recently run came back with a delta of exactly zero.
--
-- WHAT REPLACES IT IS WHAT THE PLATFORM ALREADY HAD: its own doors' telemetry. Which tools were
-- called, on whose door, how often, what they refused and whose refusal it was. That is the
-- thing itself rather than an agent's vocabulary, it needs no second runner and no credential,
-- and it cannot drift out of step with the plugin because the plugin produces it.
--
-- THE ROWS GO TOO, and that is a deliberate instruction rather than an oversight. Reports were
-- published citing these deltas; those documents keep their text and their approvals, and this
-- removes the numbers behind them. A figure nothing can reproduce and nothing should be read
-- from is worse kept than dropped.

drop table if exists zz.plugin_case_run;

alter table zz.plugin_version drop column if exists cases_digest;

-- Ruler dimensions written against case evidence. Their scores go with them by cascade -- a
-- threshold over a suite that no longer exists cannot be re-read, re-run or compared, and
-- leaving it would let a later round average a line nothing can compute against one it can.
delete from zz.rubric_dimension
 where threshold ilike '%case%'
    or name in ('the gain is the plugin''s, not the prompt''s', 'its own cases discriminate');
