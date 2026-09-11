-- Make the index rebuildable from the files, which are the actual source of truth.
--
-- `doc` is a DERIVED index. The truth is the markdown under /artifacts/teams/<team>/ —
-- `_knowledge/nodes/*.md` for journal nodes, `<initiative>/*.md` for documents. Postgres
-- exists so a question can be answered in one query instead of by reading 144 files.
--
-- But indexDoc only ever ran on write, so the index could only ever be as complete as the
-- writes that happened to pass through it. Migration 005 proved the cost: it added body,
-- title and tags, and all 44 existing rows kept empty ones — every document in the store
-- unsearchable-by-excerpt until something happened to rewrite its file. A file edited
-- outside the MCP tools, a restored backup, or a wiped database left the index silently
-- wrong with no way to notice and no way to repair.
--
-- That engine treats its SQLite cache as disposable and rebuilds from the files
-- whenever they are newer. This column is what makes the same thing cheap here: a rebuild
-- walks every file, hashes it, and skips the ones the index already has at that hash. So a
-- reindex over an unchanged corpus costs one read per file and zero writes, and the index
-- can be dropped entirely without losing anything.

alter table doc add column if not exists content_hash text not null default '';

-- A reindex ends by deleting rows whose file no longer exists, scoped to one team. Without
-- this a deleted document stays searchable forever — the worst failure this store has,
-- because it answers confidently with something that is gone.
create index if not exists doc_team_path on doc (team_slug, initiative, path);
