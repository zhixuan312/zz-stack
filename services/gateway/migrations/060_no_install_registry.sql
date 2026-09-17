-- The platform keeps no record of what a team has installed.
--
-- zz.flow_install recorded which flows each team had "installed", and the platform used it to
-- decide what went into a person's client package, which skills a team could read, and which
-- flow governed an initiative that declared none. It cannot see what is on a person's machine,
-- so the record was a claim it could not back and every use of it a restriction it could not
-- enforce. zz-core and zz-access are required; every other plugin is a person's own choice.
--
-- Nothing is carried forward. An initiative's flow is its own declaration (zz.initiative.flow,
-- or a document's `flow:`), and on this deployment every initiative already makes one; the
-- package is built from the catalog; skill reads are not scoped by team.

drop table if exists zz.flow_install;
