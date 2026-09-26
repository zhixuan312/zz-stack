---
name: zz-plugin-identify
version: 0.4
description: Stage 1 of zz-plugin-eval (IDENTIFY). Settle which plugin is being evaluated, at which exact content — catalog release or third-party capture — before any other tool on the door will resolve anything against it. Writes an immutable subject_version.
when_to_use: "The first stage of zz-plugin-eval, once an initiative exists. Never on its own — every later stage takes the subject_version_id this settles. No shell required."
---

# zz-plugin-identify

One call, one question: **what exactly is being evaluated?**

```
plugin_locate(plugin, version?, idempotency_key, initiative)
```

is IDENTIFY for a catalog plugin — `sdlc`, `zz-core`, `zz-access`, `zz-plugin-eval` itself.
It RETURNS FR-1's immutable `subject_version`: `subject_version_id`, declared version,
whole-plugin content digest, per-component manifest (skill/server/flow/config digests, each a
sha256 of the component's content, never the environment), ownership and its release mode, and `latest_protocol_version_id` — the plugin's
newest protocol version if one exists, affirmed or not and with no compatibility check: whether it
still applies is DEFINE/QUALIFY's `protocol_read`, never this. It is a mutator — it upserts `zz.eval_subject_version` through the FR-59 idempotency
ledger, so a retried call with the same `idempotency_key` replays the same row rather than
minting a second one. Omit `version` for the newest released one. REFUSES a plugin this
platform has never released. Pass `initiative`: it records `subject_version_id` as this stage's
record, which `initiative_status` hands every later stage under `records["zz-plugin-identify"]`
— the way a stage started in a new conversation finds the subject.

## A plugin the catalog has never released

```
plugin_register(name, version, source_kind, source_locator, idempotency_key, initiative)
```

is IDENTIFY for everything else — another team's plugin, a third party's, anything read from a
git repository or an npm package or a local checkout the catalog does not own. `source_kind` is
`local_dir` (a directory's own `SKILL.md` files and `flow.json`, read as given), `git` (a
repository URL, optionally `#ref`, shallow-cloned and read the same way, the commit it landed on
recorded) or `package` (an npm spec, `name@version`, fetched with `npm pack`, the tarball's own
integrity recorded). It returns the same `subject_version` shape `plugin_locate` does, so every
later tool — `plugin_profile`, `plugin_conform`, `protocol_read`, and so on — works for this
plugin exactly as it would for a catalog one.

**`plugin_register` cannot make a plugin ours.** `origin`, `owner_team`, `evolvable` and
`release_owners` are never accepted as input — the platform derives them, and a payload naming
any of the four is refused outright (FR-3). Every `plugin_register` subject lands `origin:
third_party`, `evolvable: false`, `release_owners: []` — evaluation- and proposal-only, forever,
until a real release moves it into the catalog. REFUSES a name the catalog already owns: that
plugin is registered by release, never by this tool.

## What to do with what comes back

**Say it out loud before continuing.** The plugin, the version, the digest, how many skills, how
many servers, and — from `plugin_locate`'s own response — whether a compatible protocol already
exists. Somebody reading the initiative later needs to know what was on the table without
re-running anything.

**Carry `subject_version_id`, never a bare plugin name.** Every later tool on this door takes
it. An evaluation cannot drift onto a different version of its own subject halfway through, and
a bare name gives no tool anywhere to resolve that against.

**Refuse a version nobody released.** If `plugin_locate` says no version is recorded, the plugin
either does not exist under that name or has not been released since versions began being
recorded. Neither is something to work around — call `plugin_register` if it has a source you
can read, or stop and say so.

## Pitfalls

❌ **Carrying the plugin name forward without `subject_version_id`.** Every later tool takes the
id, never the name.

❌ **Evaluating whatever is in the catalog right now.** The catalog is the next release; the
version this settles is what somebody installed.

❌ **Supplying `origin`/`owner_team`/`evolvable`/`release_owners` to `plugin_register`.** They
are derived, never accepted — the call refuses a payload naming any of them.

❌ **Registering a plugin the catalog already owns.** `plugin_register` refuses it by name; a
catalog plugin's identity comes from release, not from this door.

## Skill contract

**Outcome:** one `subject_version_id`, immutable, naming exactly the plugin content every later
stage measures — said out loud, with its plugin, version and digest, before moving on.

**Required evidence:** `plugin_locate`'s (or `plugin_register`'s) own response — the
`subject_version_id`, declared version and content digest it returns. Nothing here is inferred
from a catalog listing or a directory read by hand.

**Allowed unknowns:** whether a compatible protocol already exists — `plugin_locate` answers
that, and DEFINE/QUALIFY is what acts on it. Whether this subject has ever been run — OBSERVE
answers that next.

**Action and exit paths:** the action is call `plugin_locate` for a catalog plugin, or
`plugin_register` with a readable source for anything else, and carry the `subject_version_id`
forward. The exit is OBSERVE (`zz-plugin-observe`), always — every evaluation profiles real
runs before it discovers or defines anything. REFUSES an unreleased plugin with no readable
source stops the flow here, plainly, rather than inventing an evaluation of whatever happens to
be on disk.

**Degraded behaviour:** a plugin this platform has never released and whose source cannot be
read (an unreachable git remote, a package npm cannot resolve, a directory with no `SKILL.md`
and no `flow.json`) is not something to guess at — report the refusal `plugin_register` gives,
verbatim, and stop.
