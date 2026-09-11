-- The registry stores the installed flow's manifest and the display name of the agent the
-- projections create for it.
--
-- `agent_name` is what the TEAM sees, and it is read wherever a person meets the flow:
-- render_agent_definition names the browser agent with it, and the client package puts it in
-- each generated plugin's description. install_flow takes it, falling back to the manifest's
-- `agentName` and then to the flow's own name.
--
-- This line used to name the projections as "Open WebUI preset, codex stanza". Both are gone
-- — the front end was replaced and the terminal projection became a generated plugin package
-- — and these files declare themselves the schema's only design document, so a reader was
-- being told this column feeds two things that do not exist. Named by ROLE now, because that
-- is what survives the next replacement; the migrations that RECORD the swap say Open WebUI
-- and should, being history rather than description.
alter table zz.flow_install add column if not exists manifest jsonb;
alter table zz.flow_install add column if not exists agent_name text not null default '';
