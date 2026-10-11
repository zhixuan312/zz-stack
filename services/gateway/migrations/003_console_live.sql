-- 003_console_live.sql — the console's change hints: a notification raised by the writer's own
-- transaction, one per (team, collection) a statement touched.
--
-- The console keeps every tab fresh with one Server-Sent Events stream that carries hints and never
-- data: a hint says which collection changed, and the tab reads that collection again through its own
-- authorized read (`services/gateway/src/console/live.ts` serves it; the client is the release's own).
-- Nothing produced a hint until this file, so a tab heard nothing after its first resync.
--
-- A TRIGGER rather than a call in each writer, and that is the whole argument for this file. The
-- writer of a document is zz-core, reached by the gateway over MCP; the writer of a membership is
-- the gateway's own settings surface or an admin tool; the writer of an event is whoever called the
-- door; and psql writes all of them. A call each writer had to remember would be missing from the
-- next one. A statement-level trigger fires for every one of them at once, and it fires INSIDE the
-- writing transaction, so Postgres delivers the NOTIFY on COMMIT and a rollback sends nothing —
-- which is the property `skills/zz-meridian/references/live.md` asks an adapter to have.
--
-- One hint per statement, however many rows it moved (`FOR EACH STATEMENT`, reading the transition
-- tables), and none at all for a statement that touched no row.
--
-- THREE TRIGGERS PER TABLE, one per event, and that is Postgres's rule rather than a preference: a
-- trigger declared for more than one event may not specify transition tables — "transition tables
-- cannot be specified for triggers with more than one event" — which is what the first version of
-- this file was refused with, and how it was found was rehearsing it against a throwaway cluster.
-- So each table carries an AFTER INSERT, an AFTER UPDATE and an AFTER DELETE trigger, and the
-- function branches on `TG_OP`: plpgsql parses a branch only when it runs, so each names only the
-- transition table its own event provides. An INSERT has no `old_rows` and a DELETE has no
-- `new_rows`, and nothing may mention the one that is not there.
--
-- The payload is `{"t": "<team slug>", "c": "<collection>"}`: a team and a collection name, never a
-- row, a record or a cache tag. An empty `t` means the change is nobody's team business — a person
-- is not a team's — and the stream already treats it that way. Every collection named here is one
-- the console's reads are grouped under (`COLLECTIONS` in `src/console/live.ts`), and each was
-- derived from which of the console's routes read that table, not chosen for tidiness: a team's own
-- row is read by `/teams`, by `/people` (each person's teams) and by `/settings` (a person's own),
-- so all three are told.
--
-- `scripts/schema/compare.ts` does not model functions or triggers, so nothing in `schema-target/`
-- describes this file, and no table's rows move, so `scripts/rehearse/expect.ts` needs no entry: the
-- default assertion — row count unchanged, content hash unchanged — is the one this file must pass.
--
-- The release before this file can run on what it builds: it simply sends no hints, and a stream it
-- never opens cannot be broken by triggers it does not know about. Rollback is therefore not
-- refused, and no line below declares it.

-- The channel every console stream listens on, in this database and nowhere else. A payload is a
-- team slug and a collection name.
CREATE OR REPLACE FUNCTION zz.console_hint(team_slug text, collection text) RETURNS void
LANGUAGE sql VOLATILE AS $$
  SELECT pg_notify('zz_console_change', json_build_object('t', team_slug, 'c', collection)::text)
$$;

COMMENT ON FUNCTION zz.console_hint(text, text) IS 'class=side_effect; authority=this; question=which console collection changed, for which team, told to every tab that follows it? It carries a name and never a record.';

-- ── Tables that carry their own team_id ───────────────────────────────────────────────────────────────
-- zz.initiative, zz.knowledge_node, zz.event and zz.membership all reach their team through `team_id`,
-- so one function shape serves them; only the collections it names differ.

CREATE OR REPLACE FUNCTION zz.console_change_initiative() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE slugs text[]; s text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT t.slug) INTO slugs FROM new_rows d JOIN zz.team t ON t.id = d.team_id;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT array_agg(DISTINCT t.slug) INTO slugs
      FROM (SELECT team_id FROM new_rows UNION SELECT team_id FROM old_rows) d JOIN zz.team t ON t.id = d.team_id;
  ELSE
    SELECT array_agg(DISTINCT t.slug) INTO slugs FROM old_rows d JOIN zz.team t ON t.id = d.team_id;
  END IF;
  FOREACH s IN ARRAY coalesce(slugs, '{}') LOOP
    PERFORM zz.console_hint(s, 'initiatives');
  END LOOP;
  RETURN NULL;
END $$;

CREATE TRIGGER console_change_initiative_ins AFTER INSERT ON zz.initiative
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_initiative();
CREATE TRIGGER console_change_initiative_upd AFTER UPDATE ON zz.initiative
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_initiative();
CREATE TRIGGER console_change_initiative_del AFTER DELETE ON zz.initiative
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_initiative();

CREATE OR REPLACE FUNCTION zz.console_change_knowledge_node() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE slugs text[]; s text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT t.slug) INTO slugs FROM new_rows d JOIN zz.team t ON t.id = d.team_id;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT array_agg(DISTINCT t.slug) INTO slugs
      FROM (SELECT team_id FROM new_rows UNION SELECT team_id FROM old_rows) d JOIN zz.team t ON t.id = d.team_id;
  ELSE
    SELECT array_agg(DISTINCT t.slug) INTO slugs FROM old_rows d JOIN zz.team t ON t.id = d.team_id;
  END IF;
  FOREACH s IN ARRAY coalesce(slugs, '{}') LOOP
    PERFORM zz.console_hint(s, 'knowledge');
  END LOOP;
  RETURN NULL;
END $$;

CREATE TRIGGER console_change_knowledge_node_ins AFTER INSERT ON zz.knowledge_node
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_knowledge_node();
CREATE TRIGGER console_change_knowledge_node_upd AFTER UPDATE ON zz.knowledge_node
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_knowledge_node();
CREATE TRIGGER console_change_knowledge_node_del AFTER DELETE ON zz.knowledge_node
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_knowledge_node();

-- An event is read by the activity feed, by the runs page and by the overview's census of tool calls.
CREATE OR REPLACE FUNCTION zz.console_change_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE slugs text[]; s text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT t.slug) INTO slugs FROM new_rows d JOIN zz.team t ON t.id = d.team_id;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT array_agg(DISTINCT t.slug) INTO slugs
      FROM (SELECT team_id FROM new_rows UNION SELECT team_id FROM old_rows) d JOIN zz.team t ON t.id = d.team_id;
  ELSE
    SELECT array_agg(DISTINCT t.slug) INTO slugs FROM old_rows d JOIN zz.team t ON t.id = d.team_id;
  END IF;
  FOREACH s IN ARRAY coalesce(slugs, '{}') LOOP
    PERFORM zz.console_hint(s, 'activity');
    PERFORM zz.console_hint(s, 'runs');
    PERFORM zz.console_hint(s, 'overview');
  END LOOP;
  RETURN NULL;
END $$;

CREATE TRIGGER console_change_event_ins AFTER INSERT ON zz.event
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_event();
CREATE TRIGGER console_change_event_upd AFTER UPDATE ON zz.event
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_event();
CREATE TRIGGER console_change_event_del AFTER DELETE ON zz.event
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_event();

-- A team's roster, which the teams page counts, the people page lists per person and the settings
-- surfaces list for the team and for the person.
CREATE OR REPLACE FUNCTION zz.console_change_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE slugs text[]; s text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT t.slug) INTO slugs FROM new_rows d JOIN zz.team t ON t.id = d.team_id;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT array_agg(DISTINCT t.slug) INTO slugs
      FROM (SELECT team_id FROM new_rows UNION SELECT team_id FROM old_rows) d JOIN zz.team t ON t.id = d.team_id;
  ELSE
    SELECT array_agg(DISTINCT t.slug) INTO slugs FROM old_rows d JOIN zz.team t ON t.id = d.team_id;
  END IF;
  FOREACH s IN ARRAY coalesce(slugs, '{}') LOOP
    PERFORM zz.console_hint(s, 'teams');
    PERFORM zz.console_hint(s, 'people');
    PERFORM zz.console_hint(s, 'settings');
  END LOOP;
  RETURN NULL;
END $$;

CREATE TRIGGER console_change_membership_ins AFTER INSERT ON zz.membership
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_membership();
CREATE TRIGGER console_change_membership_upd AFTER UPDATE ON zz.membership
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_membership();
CREATE TRIGGER console_change_membership_del AFTER DELETE ON zz.membership
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_membership();

-- ── A document has no team of its own ─────────────────────────────────────────────────────────────────
-- It reaches one through its initiative. The only function here that joins twice.
CREATE OR REPLACE FUNCTION zz.console_change_doc() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE slugs text[]; s text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT t.slug) INTO slugs
      FROM new_rows d JOIN zz.initiative i ON i.id = d.initiative_id JOIN zz.team t ON t.id = i.team_id;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT array_agg(DISTINCT t.slug) INTO slugs
      FROM (SELECT initiative_id FROM new_rows UNION SELECT initiative_id FROM old_rows) d
      JOIN zz.initiative i ON i.id = d.initiative_id JOIN zz.team t ON t.id = i.team_id;
  ELSE
    SELECT array_agg(DISTINCT t.slug) INTO slugs
      FROM old_rows d JOIN zz.initiative i ON i.id = d.initiative_id JOIN zz.team t ON t.id = i.team_id;
  END IF;
  FOREACH s IN ARRAY coalesce(slugs, '{}') LOOP
    PERFORM zz.console_hint(s, 'document');
    PERFORM zz.console_hint(s, 'initiatives');
  END LOOP;
  RETURN NULL;
END $$;

CREATE TRIGGER console_change_doc_ins AFTER INSERT ON zz.doc
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_doc();
CREATE TRIGGER console_change_doc_upd AFTER UPDATE ON zz.doc
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_doc();
CREATE TRIGGER console_change_doc_del AFTER DELETE ON zz.doc
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_doc();

-- ── Tables whose slug is their own ────────────────────────────────────────────────────────────────────
-- zz.team's own row is read by the teams page, by every person's team list and by a person's own
-- settings, so all three collections are told.
CREATE OR REPLACE FUNCTION zz.console_change_team() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE slugs text[]; s text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT slug) INTO slugs FROM new_rows;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT array_agg(DISTINCT slug) INTO slugs FROM (SELECT slug FROM new_rows UNION SELECT slug FROM old_rows) d;
  ELSE
    SELECT array_agg(DISTINCT slug) INTO slugs FROM old_rows;
  END IF;
  FOREACH s IN ARRAY coalesce(slugs, '{}') LOOP
    PERFORM zz.console_hint(s, 'teams');
    PERFORM zz.console_hint(s, 'people');
    PERFORM zz.console_hint(s, 'settings');
  END LOOP;
  RETURN NULL;
END $$;

CREATE TRIGGER console_change_team_ins AFTER INSERT ON zz.team
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_team();
CREATE TRIGGER console_change_team_upd AFTER UPDATE ON zz.team
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_team();
CREATE TRIGGER console_change_team_del AFTER DELETE ON zz.team
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_team();

-- ── A person is not a team's business ──────────────────────────────────────────────────────────────────
-- zz.principal carries no team a console page is scoped by, so this one sends an empty team and every
-- console reader is told. One hint per statement that touched a row, and none for one that did not.
CREATE OR REPLACE FUNCTION zz.console_change_principal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE touched boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (SELECT 1 FROM new_rows) INTO touched;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT EXISTS (SELECT 1 FROM new_rows) OR EXISTS (SELECT 1 FROM old_rows) INTO touched;
  ELSE
    SELECT EXISTS (SELECT 1 FROM old_rows) INTO touched;
  END IF;
  IF touched THEN
    PERFORM zz.console_hint('', 'people');
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER console_change_principal_ins AFTER INSERT ON zz.principal
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_principal();
CREATE TRIGGER console_change_principal_upd AFTER UPDATE ON zz.principal
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_principal();
CREATE TRIGGER console_change_principal_del AFTER DELETE ON zz.principal
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_principal();
