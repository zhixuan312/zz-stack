-- 008_comments.sql — every table and every column of the delivered schema, commented.
--
-- Rendered from `schema-target.ts` by `scripts/schema/comments.ts`. The target is the comments'
-- one home: this file is a rendering of it and never a second place a comment is written. A
-- table or column the target declares with no classification is refused by that script rather
-- than rendered here with a placeholder, which is why every line below is a real answer.
--
-- The shape is `SCHEMA.md`'s contract — `class`, `authority` and a one-sentence `question`, with
-- `transitions` on a state_machine, `rebuilt_from` on a projection and `retention` on an
-- ephemeral or unbounded table. `checks/comment-completeness.ts` proves nothing is missing and
-- `checks/schema-inventory.ts` proves the migrated catalog carries exactly these.

COMMENT ON TABLE zz.assessment IS 'class=immutable_history; authority=this; question=what the typed service answered to one bounded semantic question, and with what model provenance, for a platform question family or a plugin-eval evaluator version, a reading of unavailable carrying its reason?; retention=kept indefinitely as immutable provenance: no production path deletes a row, and the eval rows that cite it name it by id';
COMMENT ON COLUMN zz.assessment.id IS 'class=immutable_history; authority=this; question=what this answer''s identity is, the one eval_assessment cites as its assessment_id?';
COMMENT ON COLUMN zz.assessment.family IS 'class=immutable_history; authority=this; question=which platform question family asked this question, from the nine names in @zz/contracts, set instead of an evaluator version so that exactly one of the two is non-null?';
COMMENT ON COLUMN zz.assessment.instruction_version IS 'class=immutable_history; authority=this; question=which version of the family instruction asked this question, or which version number of the evaluator asked it, never null?';
COMMENT ON COLUMN zz.assessment.question_digest IS 'class=immutable_history; authority=this; question=which exact question wording this answer belongs to, pinned by its digest?';
COMMENT ON COLUMN zz.assessment.reading IS 'class=immutable_history; authority=this; question=what the noul primitive read — yes, no, unclear or unavailable — required whenever a family asked the question?';
COMMENT ON COLUMN zz.assessment.probability IS 'class=immutable_history; authority=this; question=what probability the noul primitive put on yes?';
COMMENT ON COLUMN zz.assessment.resolved_model IS 'class=immutable_history; authority=this; question=which concrete model the supplier says answered, as distinct from the model that was asked for?';
COMMENT ON COLUMN zz.assessment.identity_assurance IS 'class=immutable_history; authority=this; question=how far the resolved model''s identity is verified, from the contracts'' assurance values?';
COMMENT ON COLUMN zz.assessment.reason IS 'class=immutable_history; authority=this; question=why there is no reading, set exactly when the reading is unavailable?';
COMMENT ON COLUMN zz.assessment.about IS 'class=immutable_history; authority=this; question=what was assessed, an external address such as the store path of the source, which a family row carries and an evaluator row leaves to the consumer that cites it?';
COMMENT ON COLUMN zz.assessment.asked_at IS 'class=immutable_history; authority=this; question=when this question was asked, never null?';
COMMENT ON COLUMN zz.assessment.evaluator_version_id IS 'class=relation; authority=this; question=which plugin-eval evaluator version asked this question, set instead of family so that exactly one of the two is non-null?';
COMMENT ON COLUMN zz.assessment.distribution IS 'class=immutable_history; authority=this; question=what the full answer distribution over the evaluator''s declared options is on a choice or score question, while probability keeps carrying the noul probability?';
COMMENT ON COLUMN zz.assessment.answer_kind IS 'class=immutable_history; authority=this; question=which typed-service primitive answered this question — noul, choice or score — where the default noul exists only so that rows written before migration 077 read as noul unchanged and every writer sets it?';
COMMENT ON COLUMN zz.assessment.team_id IS 'class=relation; authority=this; question=which team asked this question, never null, since a family row''s team is otherwise only inferable through a team-scoped slug and an evaluator row''s not at all?';
COMMENT ON COLUMN zz.assessment.initiative_id IS 'class=relation; authority=this; question=which initiative asked this question, null on every evaluator row?';
COMMENT ON COLUMN zz.assessment.model_call_id IS 'class=relation; authority=this; question=which model call produced this answer, null when no model was configured and so no call was made?';
COMMENT ON COLUMN zz.assessment.asked_by IS 'class=immutable_history; authority=this; question=which principal asked this question, never null?';

COMMENT ON TABLE zz.bug IS 'class=current_state; authority=this; question=what did a person report as wrong with the platform, and how was it closed, in the one channel from a user that needs no evidence as knowledge does and has an author as telemetry does not?';
COMMENT ON COLUMN zz.bug.id IS 'class=current_state; authority=this; question=what identifies this report?';
COMMENT ON COLUMN zz.bug.reported_at IS 'class=current_state; authority=this; question=when was this report filed?';
COMMENT ON COLUMN zz.bug.title IS 'class=current_state; authority=this; question=what one line names what was reported?';
COMMENT ON COLUMN zz.bug.detail IS 'class=current_state; authority=this; question=what happened, in the reporter''s own words?';
COMMENT ON COLUMN zz.bug.surface IS 'class=current_state; authority=this; question=which door or tool did the reporter see this on?';
COMMENT ON COLUMN zz.bug.platform_version IS 'class=current_state; authority=this; question=which platform release was running when this was reported?';
COMMENT ON COLUMN zz.bug.impact IS 'class=current_state; authority=this; question=what did this cost the reporter, from blocked work to a cosmetic defect?';
COMMENT ON COLUMN zz.bug.status IS 'class=current_state; authority=this; question=where does this report stand: open, fixed, not a bug or a duplicate?';
COMMENT ON COLUMN zz.bug.resolution IS 'class=current_state; authority=this; question=what was decided about this report?';
COMMENT ON COLUMN zz.bug.resolved_at IS 'class=current_state; authority=this; question=when was this report closed?';
COMMENT ON COLUMN zz.bug.team_id IS 'class=relation; authority=this; question=which team did the reporter belong to when they filed it?';
COMMENT ON COLUMN zz.bug.initiative_id IS 'class=relation; authority=this; question=which initiative was the reporter working on when they filed it?';
COMMENT ON COLUMN zz.bug.duplicate_of IS 'class=current_state; authority=this; question=which earlier report does this one duplicate?';
COMMENT ON COLUMN zz.bug.reported_by IS 'class=current_state; authority=this; question=which principal filed this report?';
COMMENT ON COLUMN zz.bug.resolved_by IS 'class=current_state; authority=this; question=which principal closed this report?';

COMMENT ON TABLE zz.candidate IS 'class=state_machine; authority=this; question=which patch was proposed against which exact base plugin version, with what hypothesis and expected effect, and what did its local build and gate say?; transitions=recorded->awaiting_build,awaiting_build->valid,awaiting_build->invalid';
COMMENT ON COLUMN zz.candidate.id IS 'class=state_machine; authority=this; question=what is this candidate''s stable identity, the row its release attempts bind to?';
COMMENT ON COLUMN zz.candidate.improvement_run_id IS 'class=relation; authority=this; question=which improvement attempt proposed it?';
COMMENT ON COLUMN zz.candidate.base_plugin_version_id IS 'class=relation; authority=this; question=which exact released plugin version it patches, the baseline it is built and gated against?';
COMMENT ON COLUMN zz.candidate.hypothesis IS 'class=state_machine; authority=this; question=what idea does this patch embody, the text whose normalised digest stops a hypothesis already rejected or rolled back from being proposed again?';
COMMENT ON COLUMN zz.candidate.expected_effect IS 'class=state_machine; authority=this; question=what is this patch predicted to move, the field FR-36 requires to be recorded with it?';
COMMENT ON COLUMN zz.candidate.patch_digest IS 'class=state_machine; authority=this; question=what is the sha256 of that diff, the immutable pin an approval and a build both bind to?';
COMMENT ON COLUMN zz.candidate.complexity_delta IS 'class=state_machine; authority=this; question=how much complexity does it add to or remove from its base, the axis a candidate is judged on?';
COMMENT ON COLUMN zz.candidate.touched_components IS 'class=state_machine; authority=this; question=which of the base version''s components it touches, a snapshot derived against that version''s manifest when the candidate was recorded and needed for display?';
COMMENT ON COLUMN zz.candidate.status IS 'class=state_machine; authority=this; question=where does it stand in its build lifecycle — recorded, awaiting a build, or judged valid or invalid — given that the attempt''s own states, released and rolled_back, live on release_attempt and a reader joins that row rather than reading a copy here?';
COMMENT ON COLUMN zz.candidate.created_at IS 'class=state_machine; authority=this; question=when was it recorded, the moment FR-36 required before anything about the patch could execute?';
COMMENT ON COLUMN zz.candidate.build_requested_at IS 'class=state_machine; authority=this; question=when did the build lease begin, null until candidate_validate requested a build and cleared again when an expired lease returns the candidate to recorded?';
COMMENT ON COLUMN zz.candidate.build_requested_by IS 'class=state_machine; authority=this; question=which principal may record its build, the authorization the build rules read, set with the lease and null when no lease stands?';
COMMENT ON COLUMN zz.candidate.build_result IS 'class=state_machine; authority=this; question=what did npm run candidate-build record through candidate_build_record — {ok, stage, log_tail, commands, patch_digest} — kept once candidate_validate consumes it so improvement.md and the console can say how the released patch was built and gated, null before a build lands?';
COMMENT ON COLUMN zz.candidate.build_recorded_at IS 'class=state_machine; authority=this; question=when did the build land, the timestamp the candidate''s own build rules read back?';
COMMENT ON COLUMN zz.candidate.patch IS 'class=state_machine; authority=this; question=what is the unified diff of it, the exact bytes the digest pins and a release applies?';
COMMENT ON COLUMN zz.candidate.proposed_by IS 'class=state_machine; authority=this; question=which principal proposed it?';
COMMENT ON COLUMN zz.candidate.proposer_client IS 'class=state_machine; authority=this; question=which client proposed it, null where the proposer''s identity was not recorded?';

COMMENT ON TABLE zz.console_session IS 'class=current_state; authority=this; question=which browser is signed in as which person, with what lifetime and revocation, issued where and looking at which team?; retention=swept hourly by sweepSessions, which deletes a session 7 days past its expires_at or revoked_at; the sign-in lifetime itself is 12 hours';
COMMENT ON COLUMN zz.console_session.id IS 'class=current_state; authority=this; question=what handle identifies this signed-in browser?';
COMMENT ON COLUMN zz.console_session.principal_id IS 'class=relation; authority=this; question=whose session is this?';
COMMENT ON COLUMN zz.console_session.token_hash IS 'class=current_state; authority=this; question=what is the sha256 of this session''s cookie secret?';
COMMENT ON COLUMN zz.console_session.issued_at IS 'class=current_state; authority=this; question=when was this browser signed in?';
COMMENT ON COLUMN zz.console_session.expires_at IS 'class=current_state; authority=this; question=when does this session end?';
COMMENT ON COLUMN zz.console_session.revoked_at IS 'class=current_state; authority=this; question=when was this session signed out?';
COMMENT ON COLUMN zz.console_session.last_seen_at IS 'class=current_state; authority=this; question=when did this session last make a request?';
COMMENT ON COLUMN zz.console_session.user_agent IS 'class=current_state; authority=this; question=which browser was this session issued to?';
COMMENT ON COLUMN zz.console_session.ip IS 'class=current_state; authority=this; question=what client address was this session issued from?';
COMMENT ON COLUMN zz.console_session.team_id IS 'class=relation; authority=this; question=which team is this browser looking at?';

COMMENT ON TABLE zz.control_evidence IS 'class=immutable_history; authority=this; question=what gate facts was a governed run told, in what order, against which module step, and which earlier entry a later one withdrew?';
COMMENT ON COLUMN zz.control_evidence.seq IS 'class=immutable_history; authority=this; question=in what order were this run''s gate facts appended, the replay order the kernel reads them in?';
COMMENT ON COLUMN zz.control_evidence.run_id IS 'class=relation; authority=this; question=which governed run was told this fact?';
COMMENT ON COLUMN zz.control_evidence.entry_id IS 'class=immutable_history; authority=this; question=which fact is this — doc:<path>@v<n> for a document version, approval:<path>@v<n> for the version approved, or audit:<source path> — the identity the writer mints once per fact so unique (run_id, entry_id) holds?';
COMMENT ON COLUMN zz.control_evidence.step_id IS 'class=immutable_history; authority=this; question=which module step does this fact count for, a snapshot of the module''s vocabulary at record time?';
COMMENT ON COLUMN zz.control_evidence.kind IS 'class=immutable_history; authority=this; question=is this fact a document write, an approval or an audit source, the fixed vocabulary the kernel branches on?';
COMMENT ON COLUMN zz.control_evidence.about IS 'class=immutable_history; authority=this; question=which document path does this document fact concern, or which entry id does this approval or audit fact concern, a same-run reference the writer derives from that path?';
COMMENT ON COLUMN zz.control_evidence.recorded_at IS 'class=immutable_history; authority=this; question=when was this fact recorded?';
COMMENT ON COLUMN zz.control_evidence.recorded_by IS 'class=immutable_history; authority=this; question=who recorded this fact, actor text whose values include the adoption script, which is not a principal?';
COMMENT ON COLUMN zz.control_evidence.supersedes IS 'class=immutable_history; authority=this; question=which earlier entry of this same run it withdraws, null when none stood, an FK that proves the withdrawal resolves inside the run and to a row that already exists?';

COMMENT ON TABLE zz.control_run IS 'class=current_state; authority=this; question=which initiative is enrolled in the control loop, and which reviewed module body did it enrol under?';
COMMENT ON COLUMN zz.control_run.id IS 'class=current_state; authority=this; question=what is this run''s durable identity, the row its evidence and waivers hang from and cascade with?';
COMMENT ON COLUMN zz.control_run.module_digest IS 'class=current_state; authority=this; question=which module body it enrolled under, the one deliberate historical snapshot whose mismatch with today''s module is what refuses a claim over an unreplayable history?';
COMMENT ON COLUMN zz.control_run.started_at IS 'class=current_state; authority=this; question=when was this initiative enrolled in the control loop?';
COMMENT ON COLUMN zz.control_run.initiative_id IS 'class=relation; authority=this; question=which initiative it governs, one row per initiative, cascading away with the initiative and sweeping the probe litter that matched none?';
COMMENT ON COLUMN zz.control_run.started_by IS 'class=current_state; authority=this; question=which principal enrolled it, null for the runs enrolled by the adoption script, which is not a principal?';

COMMENT ON TABLE zz.control_waiver IS 'class=immutable_history; authority=this; question=which step''s requirement did a person excuse on this run, and on what stated ground, never counting as evidence so the kernel still reports the gap?';
COMMENT ON COLUMN zz.control_waiver.seq IS 'class=immutable_history; authority=this; question=in what order were this run''s waivers recorded?';
COMMENT ON COLUMN zz.control_waiver.run_id IS 'class=relation; authority=this; question=which governed run is this gap excused within, the run whose module digest pins the rules waived against?';
COMMENT ON COLUMN zz.control_waiver.step_id IS 'class=immutable_history; authority=this; question=which module step''s requirement is excused?';
COMMENT ON COLUMN zz.control_waiver.kind IS 'class=immutable_history; authority=this; question=which requirement kind was excused — document, approval or audit — the same vocabulary evidence uses?';
COMMENT ON COLUMN zz.control_waiver.ground IS 'class=immutable_history; authority=this; question=on what stated ground did a person accept the missing step, never empty and the only place the reason is written down?';
COMMENT ON COLUMN zz.control_waiver.recorded_at IS 'class=immutable_history; authority=this; question=when was this waiver signed?';
COMMENT ON COLUMN zz.control_waiver.recorded_by IS 'class=immutable_history; authority=this; question=who signed it, actor text whose only value so far is the adoption script, which is not a principal?';

COMMENT ON TABLE zz.doc IS 'class=state_machine; authority=this; question=what is this document''s identity and its gate status, as distinct from the revisions it has had?; transitions=draft->approved,approved->draft';
COMMENT ON COLUMN zz.doc.path IS 'class=state_machine; authority=this; question=where does this document live inside its initiative''s folder?';
COMMENT ON COLUMN zz.doc.type IS 'class=state_machine; authority=this; question=which role does this document play, an agreement, a plan, a source, or another type its flow declares?';
COMMENT ON COLUMN zz.doc.status IS 'class=state_machine; authority=this; question=is this document a draft, or approved at its current revision?';
COMMENT ON COLUMN zz.doc.updated_at IS 'class=state_machine; authority=this; question=when was this document last written?';
COMMENT ON COLUMN zz.doc.body_tsv IS 'class=projection; authority=zz.doc.body; question=what is this document''s body as the search vector a full-text query matches?; rebuilt_from=body';
COMMENT ON COLUMN zz.doc.body IS 'class=projection; authority=zz.doc_revision.body; question=what does this document''s current revision say?; rebuilt_from=doc_revision[current_revision]';
COMMENT ON COLUMN zz.doc.title IS 'class=projection; authority=zz.doc_revision.title; question=what is this document''s current revision titled?; rebuilt_from=doc_revision[current_revision]';
COMMENT ON COLUMN zz.doc.tags IS 'class=projection; authority=zz.doc_revision.tags; question=which tags does this document''s current revision carry?; rebuilt_from=doc_revision[current_revision]';
COMMENT ON COLUMN zz.doc.content_hash IS 'class=projection; authority=zz.doc_revision.content_hash; question=what is the hash of this document''s current revision bytes?; rebuilt_from=doc_revision[current_revision]';
COMMENT ON COLUMN zz.doc.created_at IS 'class=state_machine; authority=this; question=when did this document first exist, never moved by a later write as updated_at is, and the instant that scopes a measurement to one initiative''s lifetime?';
COMMENT ON COLUMN zz.doc.id IS 'class=state_machine; authority=this; question=what is this document''s own identity?';
COMMENT ON COLUMN zz.doc.initiative_id IS 'class=relation; authority=this; question=which initiative does this document belong to?';
COMMENT ON COLUMN zz.doc.analyzer_version IS 'class=projection; authority=zz.doc.body; question=which analyzer generation produced this document''s search vector, so a vector from another generation can be rederived?; rebuilt_from=body';
COMMENT ON COLUMN zz.doc.current_revision IS 'class=state_machine; authority=this; question=which revision of this document is the current one?';
COMMENT ON COLUMN zz.doc.approved_revision IS 'class=state_machine; authority=this; question=which revision of this document was approved last, if any has been?';

COMMENT ON TABLE zz.doc_link IS 'class=relation; authority=this; question=which exact revision cites which other exact revision, or which source revision supports which document identity across its later revisions?';
COMMENT ON COLUMN zz.doc_link.from_doc_id IS 'class=relation; authority=this; question=which document does the citing or supporting revision belong to?';
COMMENT ON COLUMN zz.doc_link.from_revision IS 'class=relation; authority=this; question=which exact revision of that document does the citing or supporting?';
COMMENT ON COLUMN zz.doc_link.to_doc_id IS 'class=relation; authority=this; question=which document is cited, or supported?';
COMMENT ON COLUMN zz.doc_link.to_revision IS 'class=relation; authority=this; question=which exact revision is cited, null when only the target document''s identity is supported?';
COMMENT ON COLUMN zz.doc_link.kind IS 'class=relation; authority=this; question=is this a citation of one exact revision by another, or a source revision''s support for a document identity?';

COMMENT ON TABLE zz.doc_revision IS 'class=state_machine; authority=this; question=which revision of this document is this, and does it still retain the exact bytes that were written?; transitions=written->approved';
COMMENT ON COLUMN zz.doc_revision.doc_id IS 'class=relation; authority=this; question=which document does this revision belong to?';
COMMENT ON COLUMN zz.doc_revision.revision IS 'class=state_machine; authority=this; question=which revision number of that document is this?';
COMMENT ON COLUMN zz.doc_revision.content_state IS 'class=state_machine; authority=this; question=does this revision still retain the exact bytes that were written, or is it a revision known to have existed whose bytes were overwritten before any approval snapshot?';
COMMENT ON COLUMN zz.doc_revision.title IS 'class=state_machine; authority=this; question=what was this revision titled?';
COMMENT ON COLUMN zz.doc_revision.body IS 'class=state_machine; authority=this; question=what did this revision say?';
COMMENT ON COLUMN zz.doc_revision.tags IS 'class=state_machine; authority=this; question=which tags did this revision carry?';
COMMENT ON COLUMN zz.doc_revision.content_hash IS 'class=state_machine; authority=this; question=what is the hash of this revision''s bytes?';
COMMENT ON COLUMN zz.doc_revision.written_by IS 'class=state_machine; authority=this; question=which principal wrote this revision?';
COMMENT ON COLUMN zz.doc_revision.written_at IS 'class=state_machine; authority=this; question=when was this revision written?';
COMMENT ON COLUMN zz.doc_revision.revision_note IS 'class=state_machine; authority=this; question=what one line did the writer record about why this revision changed?';
COMMENT ON COLUMN zz.doc_revision.approved_by IS 'class=state_machine; authority=this; question=which principal approved these exact bytes, if they have been approved?';
COMMENT ON COLUMN zz.doc_revision.approved_at IS 'class=state_machine; authority=this; question=when were these exact bytes approved, if they have been?';
COMMENT ON COLUMN zz.doc_revision.fields IS 'class=state_machine; authority=this; question=which envelope fields does this revision carry that have no column of their own?';
COMMENT ON COLUMN zz.doc_revision.presented_at IS 'class=state_machine; authority=this; question=when were these exact bytes put in front of a person, the fact document_approve is refused by and a column rather than a sweepable event row so an approval gate cannot fail open?';

COMMENT ON TABLE zz.eval_assessment IS 'class=immutable_history; authority=this; question=in one evaluation, what did one measure answer about one subject, or why was it excluded from the score?';
COMMENT ON COLUMN zz.eval_assessment.id IS 'class=immutable_history; authority=this; question=what is this assessment row''s own identity, the id a finding cites as its reading?';
COMMENT ON COLUMN zz.eval_assessment.eval_run_id IS 'class=relation; authority=this; question=which evaluation''s score reduced this answer?';
COMMENT ON COLUMN zz.eval_assessment.measure_id IS 'class=relation; authority=this; question=which measure of the run''s protocol version was answered here?';
COMMENT ON COLUMN zz.eval_assessment.assessment_id IS 'class=relation; authority=this; question=which stored model answer in zz.assessment backed this measurement, null where the measure called no model?';
COMMENT ON COLUMN zz.eval_assessment.qualification_id IS 'class=relation; authority=this; question=which evaluator qualification was in force when this answer was taken or skipped?';
COMMENT ON COLUMN zz.eval_assessment.created_at IS 'class=immutable_history; authority=this; question=when was this answer recorded?';
COMMENT ON COLUMN zz.eval_assessment.subject_kind IS 'class=immutable_history; authority=this; question=what kind of subject this answer is about — run_level, meaning the parent run''s own observation snapshot and no child key at all, or run named by run_id, document by doc_id and doc_revision, knowledge by knowledge_node_id, bug by bug_id, or event by event_id?';
COMMENT ON COLUMN zz.eval_assessment.run_id IS 'class=relation; authority=this; question=which skill run was judged, when the subject kind is run?';
COMMENT ON COLUMN zz.eval_assessment.doc_id IS 'class=relation; authority=this; question=which document was judged, when the subject kind is document?';
COMMENT ON COLUMN zz.eval_assessment.doc_revision IS 'class=immutable_history; authority=this; question=which revision of that document pins the exact bytes judged, left null only on a legacy document subject whose revision cannot be reconstructed?';
COMMENT ON COLUMN zz.eval_assessment.knowledge_node_id IS 'class=relation; authority=this; question=which knowledge node was judged, when the subject kind is knowledge?';
COMMENT ON COLUMN zz.eval_assessment.bug_id IS 'class=relation; authority=this; question=which bug report was judged, when the subject kind is bug?';
COMMENT ON COLUMN zz.eval_assessment.event_id IS 'class=relation; authority=this; question=which recorded event was judged, when the subject kind is event?';
COMMENT ON COLUMN zz.eval_assessment.value IS 'class=immutable_history; authority=this; question=what value the measure returned for this subject, null exactly when the answer was excluded?';
COMMENT ON COLUMN zz.eval_assessment.raw_value IS 'class=immutable_history; authority=this; question=what the measure''s own unreduced reading was, kept so a reader can see past the reduced value?';
COMMENT ON COLUMN zz.eval_assessment.numerator IS 'class=immutable_history; authority=this; question=what numerator the measure counted, when its answer was a rate rather than a single reading?';
COMMENT ON COLUMN zz.eval_assessment.denominator IS 'class=immutable_history; authority=this; question=what denominator that rate was counted over?';
COMMENT ON COLUMN zz.eval_assessment.excluded_reason IS 'class=immutable_history; authority=this; question=why this measure was excluded from the score rather than answering, set exactly when value is null?';

COMMENT ON TABLE zz.eval_dimension IS 'class=immutable_history; authority=this; question=within one protocol version, which canonical meaning counts, with what weight, whether it is required for establishment, and whether it is applicable at all?';
COMMENT ON COLUMN zz.eval_dimension.id IS 'class=immutable_history; authority=this; question=which dimension does a measure, or a per-run dimension score, belong to?';
COMMENT ON COLUMN zz.eval_dimension.protocol_version_id IS 'class=relation; authority=this; question=which protocol version does this dimension belong to?';
COMMENT ON COLUMN zz.eval_dimension.key IS 'class=immutable_history; authority=this; question=what does this protocol call this dimension, the name its measures and the dashboard cite it by?';
COMMENT ON COLUMN zz.eval_dimension.canonical_kind IS 'class=immutable_history; authority=this; question=which of the six canonical evaluation meanings does this dimension measure?';
COMMENT ON COLUMN zz.eval_dimension.weight IS 'class=immutable_history; authority=this; question=how much of the version''s weighted sum does this dimension carry?';
COMMENT ON COLUMN zz.eval_dimension.required IS 'class=immutable_history; authority=this; question=must this dimension be established for the score to count under this version?';
COMMENT ON COLUMN zz.eval_dimension.applicable IS 'class=immutable_history; authority=this; question=does this dimension apply to this protocol''s subjects, or was it declared out of scope?';
COMMENT ON COLUMN zz.eval_dimension.not_applicable_reason IS 'class=immutable_history; authority=this; question=why was this dimension declared not applicable, the rationale the check pairs with the flag?';

COMMENT ON TABLE zz.eval_evaluator_qualification IS 'class=immutable_history; authority=this; question=was measure M''s evaluator found to be qualified at state S, on what evidence, by whom and when, with the latest row winning?';
COMMENT ON COLUMN zz.eval_evaluator_qualification.id IS 'class=immutable_history; authority=this; question=which qualification row does an assessment cite as the rung in force when its answer was taken or skipped?';
COMMENT ON COLUMN zz.eval_evaluator_qualification.state IS 'class=immutable_history; authority=this; question=at which qualification rung did this run find the measure''s evaluator?';
COMMENT ON COLUMN zz.eval_evaluator_qualification.evidence IS 'class=immutable_history; authority=this; question=what anchor, planted-fault, control, stability and label counts did this qualification run produce, each result carrying the assessment id behind it?';
COMMENT ON COLUMN zz.eval_evaluator_qualification.qualified_at IS 'class=immutable_history; authority=this; question=when was this qualification recorded, the timestamp that decides which row is latest?';
COMMENT ON COLUMN zz.eval_evaluator_qualification.measure_id IS 'class=relation; authority=this; question=which measure''s known-answer anchors were run?';
COMMENT ON COLUMN zz.eval_evaluator_qualification.qualified_by IS 'class=immutable_history; authority=this; question=which principal ran this qualification?';

COMMENT ON TABLE zz.eval_evaluator_version IS 'class=immutable_history; authority=this; question=what is the frozen wording and answer shape of one semantic question at version N, the exact question every assessment of it names?';
COMMENT ON COLUMN zz.eval_evaluator_version.id IS 'class=immutable_history; authority=this; question=which evaluator version does an assessment name as the exact question it was answered with?';
COMMENT ON COLUMN zz.eval_evaluator_version.version IS 'class=immutable_history; authority=this; question=which ordinal is this version of the evaluator under its stable key?';
COMMENT ON COLUMN zz.eval_evaluator_version.question IS 'class=immutable_history; authority=this; question=what instruction text does this evaluator version ask, the wording a model call must be shown verbatim?';
COMMENT ON COLUMN zz.eval_evaluator_version.answer_schema IS 'class=immutable_history; authority=this; question=what answer shape does this evaluator return — a noul, choice or score type, with its criteria map — so a reader can parse what the model said?';
COMMENT ON COLUMN zz.eval_evaluator_version.positive_answer IS 'class=immutable_history; authority=this; question=which answer counts as the good one, the polarity the reducer reads, null where the evaluator has no good side?';
COMMENT ON COLUMN zz.eval_evaluator_version.content_digest IS 'class=immutable_history; authority=this; question=what is the sha256 of the question, answer schema and positive answer, the digest an unchanged wording is reused by?';
COMMENT ON COLUMN zz.eval_evaluator_version.stable_key IS 'class=immutable_history; authority=this; question=what is this evaluator''s identity across versions, by convention prefixed with the owning plugin?';

COMMENT ON TABLE zz.eval_failure_mode IS 'class=current_state; authority=this; question=which distinct failure modes does one plugin have, one row per stable key, with what canonical description?';
COMMENT ON COLUMN zz.eval_failure_mode.id IS 'class=current_state; authority=this; question=which failure mode do its sightings and the protocol versions that fold it in point at?';
COMMENT ON COLUMN zz.eval_failure_mode.plugin_id IS 'class=relation; authority=this; question=which plugin does this failure mode belong to?';
COMMENT ON COLUMN zz.eval_failure_mode.stable_key IS 'class=current_state; authority=this; question=what identifies this failure mode within its plugin — the failing tool and refusal rule, or the two stages of a return?';
COMMENT ON COLUMN zz.eval_failure_mode.description IS 'class=current_state; authority=this; question=what is the canonical description of this failure mode, as distinct from what one sighting counted?';
COMMENT ON COLUMN zz.eval_failure_mode.created_at IS 'class=current_state; authority=this; question=when was this failure mode first identified?';

COMMENT ON TABLE zz.eval_failure_mode_sighting IS 'class=immutable_history; authority=this; question=what one failure mode was found to look like in one observation snapshot, how prevalent it was, and who it is owned by?; retention=bounded by the observation snapshots it is discovered against; append-only with no sweep, and a sighting is never deleted or rewritten';
COMMENT ON COLUMN zz.eval_failure_mode_sighting.id IS 'class=immutable_history; authority=this; question=which sighting is this, the row its evidence and provenance hang from?';
COMMENT ON COLUMN zz.eval_failure_mode_sighting.failure_mode_id IS 'class=relation; authority=this; question=which failure mode is this a sighting of?';
COMMENT ON COLUMN zz.eval_failure_mode_sighting.observation_snapshot_id IS 'class=relation; authority=this; question=in which observation snapshot was this failure mode seen?';
COMMENT ON COLUMN zz.eval_failure_mode_sighting.description IS 'class=immutable_history; authority=this; question=how was this failure mode described in this sighting, including the counts it was seen with?';
COMMENT ON COLUMN zz.eval_failure_mode_sighting.prevalence_numerator IS 'class=immutable_history; authority=this; question=in how many groups of this snapshot was the failure mode seen?';
COMMENT ON COLUMN zz.eval_failure_mode_sighting.prevalence_denominator IS 'class=immutable_history; authority=this; question=how many groups were there to see it in, so the rate can be re-derived rather than trusted?';
COMMENT ON COLUMN zz.eval_failure_mode_sighting.owner_kind IS 'class=immutable_history; authority=this; question=which party does this sighting blame — the plugin, a dependency, the platform, the environment, user input or unknown?';
COMMENT ON COLUMN zz.eval_failure_mode_sighting.owner_ref IS 'class=immutable_history; authority=this; question=which named owner does this sighting point at, where one is known?';
COMMENT ON COLUMN zz.eval_failure_mode_sighting.ownership_reason IS 'class=immutable_history; authority=this; question=why was this ownership classification reached, especially where it is unknown?';
COMMENT ON COLUMN zz.eval_failure_mode_sighting.confidence IS 'class=immutable_history; authority=this; question=how confident was the ownership classifier in this sighting?';
COMMENT ON COLUMN zz.eval_failure_mode_sighting.assessment_id IS 'class=relation; authority=this; question=which model answer behind this ownership classification can be read?';
COMMENT ON COLUMN zz.eval_failure_mode_sighting.description_model_call_id IS 'class=relation; authority=this; question=which generative-critic model call wrote this description?';
COMMENT ON COLUMN zz.eval_failure_mode_sighting.evidence_refs IS 'class=immutable_history; authority=this; question=which representative events and initiatives are the evidence for this sighting?';
COMMENT ON COLUMN zz.eval_failure_mode_sighting.discovered_by IS 'class=immutable_history; authority=this; question=which principal''s DISCOVER call found this sighting?';
COMMENT ON COLUMN zz.eval_failure_mode_sighting.discovery_key IS 'class=immutable_history; authority=this; question=under which idempotency key was this sighting written, so a replayed DISCOVER call recovers its own rows?';
COMMENT ON COLUMN zz.eval_failure_mode_sighting.created_at IS 'class=immutable_history; authority=this; question=when was this sighting recorded?';

COMMENT ON TABLE zz.eval_finding IS 'class=state_machine; authority=this; question=what conclusion did one evaluation run reach about a plugin, whose problem it names, and whether that owner has since applied or rejected the fix?; transitions=deferred->applied,deferred->rejected';
COMMENT ON COLUMN zz.eval_finding.id IS 'class=state_machine; authority=this; question=what is this finding''s stable identity, the row a correction and every decision hang from?';
COMMENT ON COLUMN zz.eval_finding.pattern IS 'class=state_machine; authority=this; question=what did the run find, in the one sentence findings.md and the proposal document print?';
COMMENT ON COLUMN zz.eval_finding.decision IS 'class=state_machine; authority=this; question=has the owner applied or rejected it — deferred while it is open, and null for a strength, which is not open work?';
COMMENT ON COLUMN zz.eval_finding.created_at IS 'class=state_machine; authority=this; question=when was it recorded, the order the documents print it in?';
COMMENT ON COLUMN zz.eval_finding.decided_at IS 'class=state_machine; authority=this; question=when was it applied or rejected?';
COMMENT ON COLUMN zz.eval_finding.decision_note IS 'class=state_machine; authority=this; question=why was it applied or rejected — for the 21 applied rows this prose is the only record of which release carried the fix, and it is empty while deferred, since the open state needs no reason and the two closed ones do?';
COMMENT ON COLUMN zz.eval_finding.owner_kind IS 'class=state_machine; authority=this; question=whose problem is it — the plugin''s, a dependency''s, the platform''s, the environment''s, the user''s input, or unknown?';
COMMENT ON COLUMN zz.eval_finding.owner_ref IS 'class=state_machine; authority=this; question=which owner exactly, free prose for a platform, dependency or environment owner and always null when owner_kind is plugin, whose plugin is already reached through the run?';
COMMENT ON COLUMN zz.eval_finding.measure_id IS 'class=relation; authority=this; question=which measure of the run''s protocol does it evidence, null when it evidences no single measure?';
COMMENT ON COLUMN zz.eval_finding.evidence_refs IS 'class=state_machine; authority=this; question=which typed references — an observation snapshot, an assessment, a document path — ground its claim, an open list by design?';
COMMENT ON COLUMN zz.eval_finding.expected_effect IS 'class=state_machine; authority=this; question=what movement does the fix it asks for expect, null wherever the finding is not a plugin-owned defect?';
COMMENT ON COLUMN zz.eval_finding.eval_run_id IS 'class=relation; authority=this; question=which evaluation run concluded it, the parent every current reader filters by, finding_record writing one on every finding since the legacy round column it shared this table with went with the round tables?';
COMMENT ON COLUMN zz.eval_finding.kind IS 'class=state_machine; authority=this; question=is it a strength, a defect or an unknown, the fact that decides whether it is open work at all, a strength being terminal at insert with a null decision?';
COMMENT ON COLUMN zz.eval_finding.superseded_by IS 'class=state_machine; authority=this; question=which later finding of the same run corrected it, null for a current one, a superseded finding also being decision=rejected so it stays closed for every reader?';
COMMENT ON COLUMN zz.eval_finding.decided_by IS 'class=state_machine; authority=this; question=which principal applied or rejected it?';

COMMENT ON TABLE zz.eval_idempotency IS 'class=ephemeral; authority=this; question=has this caller already made this call with this key, and which row did the first one produce?; retention=declared 30 days: past that age an entry is replay-dead, and no production path deletes one yet';
COMMENT ON COLUMN zz.eval_idempotency.tool IS 'class=ephemeral; authority=this; question=which mutating tool call is this retry ledger entry for?';
COMMENT ON COLUMN zz.eval_idempotency.idempotency_key IS 'class=ephemeral; authority=this; question=what key did the caller give this attempt, unique within the tool for that principal?';
COMMENT ON COLUMN zz.eval_idempotency.request_digest IS 'class=ephemeral; authority=this; question=what digest of the canonical arguments this call was made with, so a same-key call with different arguments is refused?';
COMMENT ON COLUMN zz.eval_idempotency.result_table IS 'class=ephemeral; authority=this; question=which table the first write landed in, naming a parent table where the call produced no single result row?';
COMMENT ON COLUMN zz.eval_idempotency.result_id IS 'class=ephemeral; authority=this; question=which row the first write produced, a polymorphic pointer with no foreign key because it may name any result table?';
COMMENT ON COLUMN zz.eval_idempotency.created_at IS 'class=ephemeral; authority=this; question=when the first write was recorded, the instant the 30-day sweep measures from?';
COMMENT ON COLUMN zz.eval_idempotency.principal_id IS 'class=relation; authority=this; question=which principal made the call, the first component of the key rather than an address that can change?';

COMMENT ON TABLE zz.eval_measure IS 'class=immutable_history; authority=this; question=within a dimension of one protocol version, which measure is answered by which evaluator mechanism, with what weight, and read by what rule?';
COMMENT ON COLUMN zz.eval_measure.id IS 'class=immutable_history; authority=this; question=which measure does an assessment, a finding or a qualification name?';
COMMENT ON COLUMN zz.eval_measure.dimension_id IS 'class=relation; authority=this; question=which dimension of the version does this measure belong to?';
COMMENT ON COLUMN zz.eval_measure.key IS 'class=immutable_history; authority=this; question=what is this measure''s name within its protocol version, the key findings, guardrails and qualification all cite?';
COMMENT ON COLUMN zz.eval_measure.evaluator_type IS 'class=immutable_history; authority=this; question=which mechanism answers this measure — a stored fact, a recorded outcome, a bounded semantic question, a generative critic or a human?';
COMMENT ON COLUMN zz.eval_measure.weight IS 'class=immutable_history; authority=this; question=how much of its dimension''s weighted sum does this measure carry?';
COMMENT ON COLUMN zz.eval_measure.required IS 'class=immutable_history; authority=this; question=must this measure be answered for its dimension to be established?';
COMMENT ON COLUMN zz.eval_measure.definition IS 'class=immutable_history; authority=this; question=how is this measure read — the normalisation, maximum, applicability rule, documents, whole-document flag and qualification anchors that stay per-mechanism — now that the fact path, subject kind and positive answer live in columns?';
COMMENT ON COLUMN zz.eval_measure.evaluator_version_id IS 'class=relation; authority=this; question=which frozen semantic question backs this model-driven measure?';
COMMENT ON COLUMN zz.eval_measure.protocol_version_id IS 'class=relation; authority=this; question=which protocol version does this measure belong to, denormalised so its key is unique within the version and the composite key to its dimension is expressible?';
COMMENT ON COLUMN zz.eval_measure.fact_key IS 'class=immutable_history; authority=this; question=which observation fact does this deterministic or outcome measure read?';
COMMENT ON COLUMN zz.eval_measure.subject_kind IS 'class=immutable_history; authority=this; question=which kind of reference does this model-backed measure judge — a run, a document, a knowledge node, a bug or an event?';
COMMENT ON COLUMN zz.eval_measure.guardrail_threshold IS 'class=immutable_history; authority=this; question=above what reduced value does this measure fail as a critical, non-compensatory guardrail?';

COMMENT ON TABLE zz.eval_observation_snapshot IS 'class=immutable_history; authority=this; question=what did one plugin release''s real runs look like in one resolved window, with the facts computed from them and the denominators those rates carry?';
COMMENT ON COLUMN zz.eval_observation_snapshot.id IS 'class=immutable_history; authority=this; question=which snapshot do evaluation runs, findings and failure-mode sightings name as their evidence?';
COMMENT ON COLUMN zz.eval_observation_snapshot.usable_run_count IS 'class=immutable_history; authority=this; question=how many runs in the window count as usable evidence?';
COMMENT ON COLUMN zz.eval_observation_snapshot.total_run_count IS 'class=immutable_history; authority=this; question=how many runs fell in the window at all, the denominator a minimum-runs rule is read against?';
COMMENT ON COLUMN zz.eval_observation_snapshot.evidence_digest IS 'class=immutable_history; authority=this; question=what is the sha256 of this snapshot''s canonical facts, the value a recompute is compared against to report drift?';
COMMENT ON COLUMN zz.eval_observation_snapshot.created_at IS 'class=immutable_history; authority=this; question=when was this snapshot captured?';
COMMENT ON COLUMN zz.eval_observation_snapshot.facts IS 'class=immutable_history; authority=this; question=which facts did computeObservation write for this snapshot — every ObservedFact of observe-facts.ts''s OBSERVATION_FACT_KEYS, keyed by fact name, one entry of which a deterministic or outcome measure reads by its dotted definition.factPath — and is it null when the snapshot carries no computed facts, every such measure then answering excluded with a named reason?';
COMMENT ON COLUMN zz.eval_observation_snapshot.plugin_version_id IS 'class=relation; authority=this; question=which released plugin version was observed?';
COMMENT ON COLUMN zz.eval_observation_snapshot.window_from IS 'class=immutable_history; authority=this; question=from when does the observed window open, null when no window was resolved?';
COMMENT ON COLUMN zz.eval_observation_snapshot.window_to IS 'class=immutable_history; authority=this; question=until when does the observed window run, null when no window was resolved?';
COMMENT ON COLUMN zz.eval_observation_snapshot.surface_observed IS 'class=immutable_history; authority=this; question=how many of the plugin''s declared tool surfaces did the window actually observe?';
COMMENT ON COLUMN zz.eval_observation_snapshot.surface_total IS 'class=immutable_history; authority=this; question=how many surfaces were there to observe?';
COMMENT ON COLUMN zz.eval_observation_snapshot.surface_source IS 'class=immutable_history; authority=this; question=where did the surface total come from, so a coverage figure can be trusted?';
COMMENT ON COLUMN zz.eval_observation_snapshot.platform_version IS 'class=immutable_history; authority=this; question=which platform build produced this observation?';
COMMENT ON COLUMN zz.eval_observation_snapshot.recorded_by IS 'class=immutable_history; authority=this; question=which principal ran this observation?';

COMMENT ON TABLE zz.eval_protocol_failure_mode IS 'class=relation; authority=this; question=which failure modes does one protocol version fold into its lineage?';
COMMENT ON COLUMN zz.eval_protocol_failure_mode.protocol_version_id IS 'class=relation; authority=this; question=which protocol version folds in this failure mode?';
COMMENT ON COLUMN zz.eval_protocol_failure_mode.failure_mode_id IS 'class=relation; authority=this; question=which failure mode does this protocol version fold in?';

COMMENT ON TABLE zz.eval_protocol_version IS 'class=state_machine; authority=this; question=what frozen, immutable definition of good does one plugin have at protocol version N, and has an approved protocol.md been bound to it yet?; transitions=recorded->affirmed';
COMMENT ON COLUMN zz.eval_protocol_version.id IS 'class=state_machine; authority=this; question=which protocol version does every dimension, measure, document binding and published score name as the definition it was produced under?';
COMMENT ON COLUMN zz.eval_protocol_version.version IS 'class=state_machine; authority=this; question=which ordinal is this version of the lineage, the number whose successor refuses to reuse it?';
COMMENT ON COLUMN zz.eval_protocol_version.purpose IS 'class=state_machine; authority=this; question=which plugin purpose does this version measure against, the text whose change makes the version stale?';
COMMENT ON COLUMN zz.eval_protocol_version.qualification_policy IS 'class=state_machine; authority=this; question=which thresholds and minimum qualification rung must an evaluator clear before its answers may back a score under this version?';
COMMENT ON COLUMN zz.eval_protocol_version.scoring_policy IS 'class=state_machine; authority=this; question=which establishment rules, such as bootstrap and minimum measure coverage, and which uncertainty settings does scoring under this version follow?';
COMMENT ON COLUMN zz.eval_protocol_version.improvement_policy IS 'class=state_machine; authority=this; question=what release policy does this version apply, now that the critical guardrails have moved onto the measures and evolvable has been dropped?';
COMMENT ON COLUMN zz.eval_protocol_version.content_digest IS 'class=state_machine; authority=this; question=what is the sha256 of this version''s canonical body, the digest an approved protocol.md must quote before the version may be affirmed?';
COMMENT ON COLUMN zz.eval_protocol_version.created_at IS 'class=state_machine; authority=this; question=when was this protocol version recorded?';
COMMENT ON COLUMN zz.eval_protocol_version.plugin_id IS 'class=relation; authority=this; question=which plugin is this protocol version for?';
COMMENT ON COLUMN zz.eval_protocol_version.protocol_key IS 'class=state_machine; authority=this; question=what is the lineage''s display name, shown next to the version number?';
COMMENT ON COLUMN zz.eval_protocol_version.observable_surfaces IS 'class=state_machine; authority=this; question=which tool and evidence surfaces does this version cover, so a surface outside the set counts as new evidence and forces a new version?';
COMMENT ON COLUMN zz.eval_protocol_version.approved_doc_id IS 'class=relation; authority=this; question=which approved protocol.md document is bound to this version?';
COMMENT ON COLUMN zz.eval_protocol_version.affirmed_by IS 'class=state_machine; authority=this; question=which principal affirmed this version by binding the approved document?';
COMMENT ON COLUMN zz.eval_protocol_version.affirmed_at IS 'class=state_machine; authority=this; question=when was this version affirmed?';
COMMENT ON COLUMN zz.eval_protocol_version.recorded_by IS 'class=state_machine; authority=this; question=which principal recorded this version?';
COMMENT ON COLUMN zz.eval_protocol_version.approved_doc_revision IS 'class=state_machine; authority=this; question=which revision of the approved protocol.md was affirmed, so the binding names exact bytes rather than a document that may have moved since?';

COMMENT ON TABLE zz.eval_run IS 'class=state_machine; authority=this; question=which evaluation bound one protocol version to one observation snapshot, and what score, status, guardrail verdict and uncertainty did it publish?; transitions=created->scored';
COMMENT ON COLUMN zz.eval_run.id IS 'class=state_machine; authority=this; question=what is this evaluation run''s stable identity, the handle its assessments, findings, improvements and release verdicts hang off?';
COMMENT ON COLUMN zz.eval_run.protocol_version_id IS 'class=relation; authority=this; question=which protocol version, with its dimensions and measures, did this run score against?';
COMMENT ON COLUMN zz.eval_run.score_status IS 'class=state_machine; authority=this; question=is this run''s published score established, provisional or not_established, and null only while the run has not been scored?';
COMMENT ON COLUMN zz.eval_run.overall_score IS 'class=state_machine; authority=this; question=what score between 0 and 10 did this run publish?';
COMMENT ON COLUMN zz.eval_run.guardrail_status IS 'class=state_machine; authority=this; question=did this run''s critical guardrails pass or fail, or come back not_established?';
COMMENT ON COLUMN zz.eval_run.created_at IS 'class=state_machine; authority=this; question=when was this run started?';
COMMENT ON COLUMN zz.eval_run.team_id IS 'class=relation; authority=this; question=which team ran this evaluation, whose artifact store its document subjects were resolved against and which the named initiative must belong to?';
COMMENT ON COLUMN zz.eval_run.initiative_id IS 'class=relation; authority=this; question=which initiative ran this evaluation, when it was started from one?';
COMMENT ON COLUMN zz.eval_run.observation_snapshot_id IS 'class=relation; authority=this; question=which observation snapshot of real production use was this run scored against?';
COMMENT ON COLUMN zz.eval_run.score_lower IS 'class=state_machine; authority=this; question=what is the lower bound of this run''s published uncertainty interval?';
COMMENT ON COLUMN zz.eval_run.score_upper IS 'class=state_machine; authority=this; question=what is the upper bound of this run''s published uncertainty interval?';
COMMENT ON COLUMN zz.eval_run.measure_coverage IS 'class=state_machine; authority=this; question=what share of the protocol''s declared measure weight this run actually scored?';
COMMENT ON COLUMN zz.eval_run.establishment_blocked_by IS 'class=state_machine; authority=this; question=which reasons stopped this run''s score from being established, each named by the policy that failed?';
COMMENT ON COLUMN zz.eval_run.scorer_version IS 'class=state_machine; authority=this; question=which platform version''s scoring code produced this published result, so a recompute under newer code cannot silently move the comparison a rollback turns on?';
COMMENT ON COLUMN zz.eval_run.started_by IS 'class=state_machine; authority=this; question=which principal started this run?';
COMMENT ON COLUMN zz.eval_run.scored_at IS 'class=state_machine; authority=this; question=when was this run''s result published, the terminal marker that closes it against every later re-scoring?';

COMMENT ON TABLE zz.eval_run_dimension IS 'class=immutable_history; authority=this; question=what score and coverage did one scored run publish for one dimension of its protocol?';
COMMENT ON COLUMN zz.eval_run_dimension.eval_run_id IS 'class=relation; authority=this; question=which scored run published this per-dimension result?';
COMMENT ON COLUMN zz.eval_run_dimension.protocol_version_id IS 'class=relation; authority=this; question=which protocol version do both the run and the dimension this row joins belong to, the shared key that keeps them from disagreeing?';
COMMENT ON COLUMN zz.eval_run_dimension.dimension_id IS 'class=relation; authority=this; question=which declared dimension of that protocol version does this score belong to?';
COMMENT ON COLUMN zz.eval_run_dimension.score IS 'class=immutable_history; authority=this; question=what score between 0 and 10 did the run publish for this dimension, null when the dimension did not apply?';
COMMENT ON COLUMN zz.eval_run_dimension.coverage IS 'class=immutable_history; authority=this; question=what share of this dimension''s declared measure weight was scored, null when it was not measured?';

COMMENT ON TABLE zz.event IS 'class=immutable_history; authority=this; question=what did the platform do or get asked to do, one append-only timestamped act — a tool call at a door, an admin act, a knowledge-journal act or a sign-in — the only fallback being /data/events-unwritten.jsonl when a write fails?; retention=audit kinds (admin.*, credential.*, console.*, team.*, bug.*, pkg.download) are kept indefinitely; tool_call and knowledge.* may age out once volume requires it, except a row an evaluation cites';
COMMENT ON COLUMN zz.event.id IS 'class=immutable_history; authority=this; question=what is this act''s row identity, the one an evaluation cites as event:<id>?';
COMMENT ON COLUMN zz.event.ts IS 'class=immutable_history; authority=this; question=when did this act happen, one row per act and no update?';
COMMENT ON COLUMN zz.event.kind IS 'class=immutable_history; authority=this; question=what kind of act this is, from an open dot-separated vocabulary of lower-case words such as tool_call, knowledge.search or team.archive?';
COMMENT ON COLUMN zz.event.subject IS 'class=immutable_history; authority=this; question=what is this act about — the raw <door>:<tool> for a tool_call, a node or bug id elsewhere, or the raw query text for knowledge.search, kept deliberately although a tool call may not record the text it was asked?';
COMMENT ON COLUMN zz.event.detail IS 'class=immutable_history; authority=this; question=what open extra payload this act carries — the caller hash, client, argument names, ids, shapes and step_sha — now that run has moved to session and the ms and bytes keys have backfilled duration_ms and response_bytes?';
COMMENT ON COLUMN zz.event.ok IS 'class=immutable_history; authority=this; question=did the call work, in the platform''s own terms rather than as a transport status, since an mcp tool that refuses answers http 200 with error: in its text, and every tool_call row must carry it?';
COMMENT ON COLUMN zz.event.refusal IS 'class=immutable_history; authority=this; question=what refusal sentence the platform returned, redacted and capped, when the call did not work?';
COMMENT ON COLUMN zz.event.run_id IS 'class=relation; authority=this; question=which skill_run groups this event, stamped in the same transaction as the event once the matching run identity is created or found and never timer-backfilled?';
COMMENT ON COLUMN zz.event.team_id IS 'class=relation; authority=this; question=which team this act belongs to, the composite keys to initiative and skill_run proving they share that team, null only where the team itself is gone?';
COMMENT ON COLUMN zz.event.duration_ms IS 'class=immutable_history; authority=this; question=how long the request took, null before 2026-09-14 13:06 where the latency sat in detail.ms until it was backfilled here?';
COMMENT ON COLUMN zz.event.request_bytes IS 'class=immutable_history; authority=this; question=how large the request body was, as content-length, null on rows written before measurement began on 2026-09-14 13:06?';
COMMENT ON COLUMN zz.event.response_bytes IS 'class=immutable_history; authority=this; question=how large the response body was, null before 2026-09-14 13:06 where detail.bytes stood in for it until the backfill?';
COMMENT ON COLUMN zz.event.batched IS 'class=immutable_history; authority=this; question=does this row share one json-rpc batch''s latency and size with the other calls in it, so that a percentile reader must drop it — a real protocol case no client has sent yet, so every row is false?';
COMMENT ON COLUMN zz.event.plugin IS 'class=immutable_history; authority=this; question=which plugin''s door served this call, a deliberate snapshot never resolved from flow_install or the x-zz-client header and null when no plugin door served it, although the 157 sdlc rows of 09-14 to 09-16 came from an older skill-based rule through zz.plugin_version_skill and no row records which rule stamped it?';
COMMENT ON COLUMN zz.event.plugin_version IS 'class=immutable_history; authority=this; question=which version the door''s own plugin reported in its initialize handshake, never set while plugin is null but not necessarily set while plugin is — 64 rows carry a plugin with no version because the door had not handshaken in that process, and 175 of the values name no zz.plugin_version row?';
COMMENT ON COLUMN zz.event.tool_key IS 'class=immutable_history; authority=this; question=what the alias-resolved <door>:<tool> name of this call is, stamped at write so that a row reads as one series across a rename with no further lookup, required on every tool_call row and differing from subject on the 2205 rows renamed since?';
COMMENT ON COLUMN zz.event.refusal_owner IS 'class=immutable_history; authority=this; question=whose refusal this was — guardrail, ours, theirs or other — set only on a call that did not work, and possibly with no refusal text at all, as on the one row whose answer was unreadable?';
COMMENT ON COLUMN zz.event.actor_id IS 'class=relation; authority=this; question=which principal did this admin or knowledge-journal act, null on a tool_call, where the old actor text''s empty string became null and every non-empty value resolved?';
COMMENT ON COLUMN zz.event.initiative_id IS 'class=relation; authority=this; question=which initiative the caller was working on, carried forward per caller, null when the act belongs to none?';
COMMENT ON COLUMN zz.event.session IS 'class=immutable_history; authority=this; question=what the caller''s conversation key is — a hash of the caller''s email, client and 45-minute bucket minted in gateway memory, which a gateway restart splits and which groups the events a skill_run is built from?';
COMMENT ON COLUMN zz.event.skill_version_id IS 'class=relation; authority=this; question=which skill version the caller was following, resolved at write as the latest released version of the skill the caller last loaded so that a later re-registration cannot move it, null when no skill was loaded?';

COMMENT ON TABLE zz.improvement_run IS 'class=immutable_history; authority=this; question=which evaluation run''s plugin-owned findings were chosen as one improvement attempt''s target?';
COMMENT ON COLUMN zz.improvement_run.id IS 'class=immutable_history; authority=this; question=what is this attempt''s stable identity, the row its candidates hang from?';
COMMENT ON COLUMN zz.improvement_run.eval_run_id IS 'class=relation; authority=this; question=which evaluation run''s findings seeded it, the run initiative_run resolves the initiative''s newest attempt from?';
COMMENT ON COLUMN zz.improvement_run.created_at IS 'class=immutable_history; authority=this; question=when was it opened, the order the initiative''s newest improvement run is taken in?';

COMMENT ON TABLE zz.improvement_run_finding IS 'class=relation; authority=this; question=which findings did one improvement attempt take as its target, the join that makes finding-to-change provenance real rather than prose?';
COMMENT ON COLUMN zz.improvement_run_finding.improvement_run_id IS 'class=relation; authority=this; question=which improvement attempt targeted this finding?';
COMMENT ON COLUMN zz.improvement_run_finding.finding_id IS 'class=relation; authority=this; question=which finding did that attempt take as its target, always a plugin-owned one of the attempt''s own evaluation run?';

COMMENT ON TABLE zz.initiative IS 'class=state_machine; authority=this; question=what is the lifecycle state of one piece of delivery work, from opened to its outcome?; transitions=open->accepted,open->delivered,open->abandoned';
COMMENT ON COLUMN zz.initiative.id IS 'class=state_machine; authority=this; question=what is this initiative''s own identity?';
COMMENT ON COLUMN zz.initiative.team_id IS 'class=relation; authority=this; question=which team owns this initiative?';
COMMENT ON COLUMN zz.initiative.slug IS 'class=state_machine; authority=this; question=what is this initiative''s stable, human-chosen identifier within its team?';
COMMENT ON COLUMN zz.initiative.flow IS 'class=state_machine; authority=this; question=which flow does this initiative run, if any?';
COMMENT ON COLUMN zz.initiative.opened_at IS 'class=state_machine; authority=this; question=when did this initiative''s lifecycle begin?';
COMMENT ON COLUMN zz.initiative.opened_by IS 'class=state_machine; authority=this; question=which principal opened this initiative?';
COMMENT ON COLUMN zz.initiative.closed_at IS 'class=state_machine; authority=this; question=when did this initiative''s lifecycle end, if it has?';
COMMENT ON COLUMN zz.initiative.closed_by IS 'class=state_machine; authority=this; question=which principal closed this initiative, if it has?';
COMMENT ON COLUMN zz.initiative.outcome IS 'class=state_machine; authority=this; question=what did this initiative''s lifecycle conclude, if it has closed?';
COMMENT ON COLUMN zz.initiative.accepted_by IS 'class=state_machine; authority=this; question=who is recorded as having signed off on this initiative''s accepted outcome, if it was accepted?';
COMMENT ON COLUMN zz.initiative.no_signoff_reason IS 'class=state_machine; authority=this; question=why was this initiative''s accepted outcome accepted without a named sign-off, if so?';

COMMENT ON TABLE zz.initiative_fact IS 'class=current_state; authority=this; question=which branch facts has this initiative decided, each written once by the stage that decided it and never revised, now that the `_facts.json` copy is retired and the row is the authority?';
COMMENT ON COLUMN zz.initiative_fact.fact IS 'class=current_state; authority=this; question=which named branch fact of this initiative''s flow does this row record?';
COMMENT ON COLUMN zz.initiative_fact.value IS 'class=current_state; authority=this; question=what did the deciding stage record this branch fact to be?';
COMMENT ON COLUMN zz.initiative_fact.set_at IS 'class=current_state; authority=this; question=when was this branch fact decided?';
COMMENT ON COLUMN zz.initiative_fact.initiative_id IS 'class=relation; authority=this; question=which initiative does this branch fact belong to?';

COMMENT ON TABLE zz.initiative_record IS 'class=current_state; authority=this; question=which ids did each stage of this initiative mint, latest-wins so a stage that runs again supersedes what it recorded before?';
COMMENT ON COLUMN zz.initiative_record.initiative_id IS 'class=relation; authority=this; question=which initiative does this stage record belong to?';
COMMENT ON COLUMN zz.initiative_record.stage IS 'class=current_state; authority=this; question=which stage of the flow minted these ids?';
COMMENT ON COLUMN zz.initiative_record.id_name IS 'class=current_state; authority=this; question=which of the ids the stage minted is this, under the name the stage itself gives it?';
COMMENT ON COLUMN zz.initiative_record.value IS 'class=current_state; authority=this; question=what is the id this stage recorded under that name?';
COMMENT ON COLUMN zz.initiative_record.set_at IS 'class=current_state; authority=this; question=when did this stage last record this id?';

COMMENT ON TABLE zz.knowledge_node IS 'class=current_state; authority=this; question=which lessons does this shelf currently carry, what does each say, and which have been superseded by which?';
COMMENT ON COLUMN zz.knowledge_node.id IS 'class=current_state; authority=this; question=what is this node''s stable identity?';
COMMENT ON COLUMN zz.knowledge_node.kind IS 'class=current_state; authority=this; question=which of the six node kinds is this lesson?';
COMMENT ON COLUMN zz.knowledge_node.lifecycle IS 'class=current_state; authority=this; question=does this node still stand, or has it been superseded?';
COMMENT ON COLUMN zz.knowledge_node.title IS 'class=current_state; authority=this; question=what is this node titled?';
COMMENT ON COLUMN zz.knowledge_node.body IS 'class=current_state; authority=this; question=what does this lesson say?';
COMMENT ON COLUMN zz.knowledge_node.body_tsv IS 'class=projection; authority=zz.knowledge_node.body; question=what does this node''s body look like as the search vector a full-text query matches?; rebuilt_from=body';
COMMENT ON COLUMN zz.knowledge_node.tags IS 'class=current_state; authority=this; question=which subjects is this node tagged under?';
COMMENT ON COLUMN zz.knowledge_node.content_hash IS 'class=current_state; authority=this; question=what hash of this node''s derived fields lets a reindex skip it because nothing it derives has changed?';
COMMENT ON COLUMN zz.knowledge_node.created_at IS 'class=current_state; authority=this; question=when was this node minted?';
COMMENT ON COLUMN zz.knowledge_node.updated_at IS 'class=current_state; authority=this; question=when did this node last change?';
COMMENT ON COLUMN zz.knowledge_node.analyzer_version IS 'class=projection; authority=zz.knowledge_node.body; question=which analyzer generation produced this node''s search vector, so a vector from another generation can be rederived?; rebuilt_from=body';
COMMENT ON COLUMN zz.knowledge_node.team_id IS 'class=relation; authority=this; question=which shelf does this node belong to?';
COMMENT ON COLUMN zz.knowledge_node.node_ordinal IS 'class=current_state; authority=this; question=which ordinal does this node''s file carry within its shelf?';
COMMENT ON COLUMN zz.knowledge_node.slug IS 'class=current_state; authority=this; question=what is this node''s slug in its shelf-local file address?';
COMMENT ON COLUMN zz.knowledge_node.superseded_by_id IS 'class=relation; authority=this; question=which node supersedes this one?';

COMMENT ON TABLE zz.knowledge_node_evidence IS 'class=relation; authority=this; question=which initiatives was this node learned from, including initiatives of a team other than the node''s own shelf, since a citation is not tenant-scoped?';
COMMENT ON COLUMN zz.knowledge_node_evidence.node_id IS 'class=relation; authority=this; question=which node does this learned-from link belong to?';
COMMENT ON COLUMN zz.knowledge_node_evidence.initiative_id IS 'class=relation; authority=this; question=which initiative was this node learned from?';

COMMENT ON TABLE zz.mcp_oauth_authz IS 'class=ephemeral; authority=this; question=which authorization code is issued to which client for which person and door, awaiting a single PKCE exchange?; retention=swept by the hourly sweepSessions once expires_at passes, and consumed atomically at the PKCE exchange; the code window is 10 minutes';
COMMENT ON COLUMN zz.mcp_oauth_authz.client_id IS 'class=relation; authority=this; question=which registered client was this code issued to?';
COMMENT ON COLUMN zz.mcp_oauth_authz.principal_id IS 'class=relation; authority=this; question=which person authorized this code?';
COMMENT ON COLUMN zz.mcp_oauth_authz.redirect_uri IS 'class=ephemeral; authority=this; question=which redirect URI is this code bound to?';
COMMENT ON COLUMN zz.mcp_oauth_authz.code_challenge IS 'class=ephemeral; authority=this; question=what PKCE S256 challenge must the exchange answer?';
COMMENT ON COLUMN zz.mcp_oauth_authz.resource IS 'class=ephemeral; authority=this; question=which MCP door was this code authorized for?';
COMMENT ON COLUMN zz.mcp_oauth_authz.created_at IS 'class=ephemeral; authority=this; question=when was this code issued?';
COMMENT ON COLUMN zz.mcp_oauth_authz.code_hash IS 'class=ephemeral; authority=this; question=what is the sha256 of the authorization code?';
COMMENT ON COLUMN zz.mcp_oauth_authz.expires_at IS 'class=ephemeral; authority=this; question=when does this code''s ten-minute window end?';
COMMENT ON COLUMN zz.mcp_oauth_authz.used_at IS 'class=ephemeral; authority=this; question=when was this code exchanged?';

COMMENT ON TABLE zz.mcp_oauth_client IS 'class=current_state; authority=this; question=which OAuth public client registered itself, and which redirect URIs may it receive codes at?; retention=durable until explicitly revoked by client_revoke: an open registration endpoint makes the table unbounded, and inactivity alone never deletes a registration';
COMMENT ON COLUMN zz.mcp_oauth_client.client_id IS 'class=current_state; authority=this; question=what is this client''s public identity?';
COMMENT ON COLUMN zz.mcp_oauth_client.redirect_uris IS 'class=current_state; authority=this; question=which redirect URIs may this client receive a code at?';
COMMENT ON COLUMN zz.mcp_oauth_client.name IS 'class=current_state; authority=this; question=what name did this client declare for itself?';
COMMENT ON COLUMN zz.mcp_oauth_client.created_at IS 'class=current_state; authority=this; question=when did this client register?';
COMMENT ON COLUMN zz.mcp_oauth_client.revoked_at IS 'class=current_state; authority=this; question=when was this client''s registration revoked?';

COMMENT ON TABLE zz.membership IS 'class=relation; authority=this; question=which person belongs to which team, in what team role, and who put them there?';
COMMENT ON COLUMN zz.membership.team_id IS 'class=relation; authority=this; question=which team does this membership join?';
COMMENT ON COLUMN zz.membership.principal_id IS 'class=relation; authority=this; question=which person does this membership join?';
COMMENT ON COLUMN zz.membership.role IS 'class=relation; authority=this; question=what team authority does this person hold in this team?';
COMMENT ON COLUMN zz.membership.added_by IS 'class=relation; authority=this; question=which principal added this person to this team?';
COMMENT ON COLUMN zz.membership.created_at IS 'class=relation; authority=this; question=when was this person added to this team?';

COMMENT ON TABLE zz.model_call IS 'class=immutable_history; authority=this; question=what one outbound model request the platform itself made cost and returned — which purpose, which model, how many tokens, how long, and whether it worked?; retention=kept indefinitely; it is the provenance an assessment names, and a row an evaluation cites is never purged';
COMMENT ON COLUMN zz.model_call.id IS 'class=immutable_history; authority=this; question=what this call''s identity is, the one an assessment names as the call that produced its answer?';
COMMENT ON COLUMN zz.model_call.ts IS 'class=immutable_history; authority=this; question=when this call was made?';
COMMENT ON COLUMN zz.model_call.purpose IS 'class=immutable_history; authority=this; question=which caller path made this call — typed-judge, failure-discover, or the historic plugin-judge — from a small code-owned vocabulary?';
COMMENT ON COLUMN zz.model_call.model IS 'class=immutable_history; authority=this; question=which model was asked for, spelled <provider>/<model> so that one column carries one spelling?';
COMMENT ON COLUMN zz.model_call.input_tokens IS 'class=immutable_history; authority=this; question=how many input tokens the provider reported, null when it reported none?';
COMMENT ON COLUMN zz.model_call.output_tokens IS 'class=immutable_history; authority=this; question=how many output tokens the provider reported, null when it reported none?';
COMMENT ON COLUMN zz.model_call.cache_read_tokens IS 'class=immutable_history; authority=this; question=how many input tokens the provider served from cache, null when it reported no cache figure and 0 when it reported a cache of zero?';
COMMENT ON COLUMN zz.model_call.duration_ms IS 'class=immutable_history; authority=this; question=how long the call took, never null even when it failed?';
COMMENT ON COLUMN zz.model_call.ok IS 'class=immutable_history; authority=this; question=whether the call succeeded, never null even when the model never answered?';
COMMENT ON COLUMN zz.model_call.attempts IS 'class=immutable_history; authority=this; question=how many attempts the typed service needed inside one ask — a real retry loop that no row has exercised yet, so every row is 1, while the judge path deliberately makes one attempt?';
COMMENT ON COLUMN zz.model_call.error IS 'class=immutable_history; authority=this; question=why the call failed, set only when it did not succeed and kept for a transport failure that left no assessment behind, since a failure that produced an answer already carries its reason there?';

COMMENT ON TABLE zz.passkey IS 'class=current_state; authority=this; question=which registered authenticator proves which person at the browser door?';
COMMENT ON COLUMN zz.passkey.id IS 'class=current_state; authority=this; question=what is this WebAuthn credential id?';
COMMENT ON COLUMN zz.passkey.principal_id IS 'class=relation; authority=this; question=which person owns this authenticator?';
COMMENT ON COLUMN zz.passkey.public_key IS 'class=current_state; authority=this; question=what COSE public key verifies this authenticator''s assertions?';
COMMENT ON COLUMN zz.passkey.counter IS 'class=current_state; authority=this; question=what signature counter has this authenticator reached?';
COMMENT ON COLUMN zz.passkey.transports IS 'class=current_state; authority=this; question=how is this authenticator reached?';
COMMENT ON COLUMN zz.passkey.label IS 'class=current_state; authority=this; question=what device name is this authenticator shown under?';
COMMENT ON COLUMN zz.passkey.created_at IS 'class=current_state; authority=this; question=when was this device enrolled?';
COMMENT ON COLUMN zz.passkey.last_used_at IS 'class=current_state; authority=this; question=when did this device last sign in?';

COMMENT ON TABLE zz.passkey_challenge IS 'class=ephemeral; authority=this; question=which WebAuthn challenge has this server issued to one browser, awaiting the signed answer to it?; retention=swept by the hourly sweepSessions once expires_at passes, and consumed by the single-use delete at the ceremony; the challenge window is 5 minutes';
COMMENT ON COLUMN zz.passkey_challenge.id IS 'class=ephemeral; authority=this; question=what ceremony handle is carried in the zz_ceremony cookie?';
COMMENT ON COLUMN zz.passkey_challenge.challenge IS 'class=ephemeral; authority=this; question=what value must the authenticator sign?';
COMMENT ON COLUMN zz.passkey_challenge.kind IS 'class=ephemeral; authority=this; question=is this challenge a registration or a login?';
COMMENT ON COLUMN zz.passkey_challenge.principal_id IS 'class=relation; authority=this; question=which person is this registration challenge for?';
COMMENT ON COLUMN zz.passkey_challenge.redirect_to IS 'class=ephemeral; authority=this; question=where does this ceremony land after sign-in?';
COMMENT ON COLUMN zz.passkey_challenge.created_at IS 'class=ephemeral; authority=this; question=when was this challenge issued?';
COMMENT ON COLUMN zz.passkey_challenge.expires_at IS 'class=ephemeral; authority=this; question=when does this challenge''s five-minute window end?';

COMMENT ON TABLE zz.passkey_enrolment IS 'class=ephemeral; authority=this; question=which single-use, expiring invitation lets one named principal register a passkey?; retention=swept 7 days after use or expiry, within 14 days of issue; the durable audit is the admin.issue_enrolment event';
COMMENT ON COLUMN zz.passkey_enrolment.token_hash IS 'class=ephemeral; authority=this; question=what is the sha256 of this invitation link''s secret?';
COMMENT ON COLUMN zz.passkey_enrolment.principal_id IS 'class=relation; authority=this; question=which person may enrol with this link?';
COMMENT ON COLUMN zz.passkey_enrolment.expires_at IS 'class=ephemeral; authority=this; question=when does this invitation''s seven-day window end?';
COMMENT ON COLUMN zz.passkey_enrolment.used_at IS 'class=ephemeral; authority=this; question=when was this invitation spent?';

COMMENT ON TABLE zz.pat IS 'class=current_state; authority=this; question=which bearer credential does a program hold to act as a person, confined to which team and client, with what lifetime and revocation?; retention=kept as durable provenance until explicitly revoked or expired; a revoked row is never deleted, because pat_list and client_revoke read it';
COMMENT ON COLUMN zz.pat.id IS 'class=current_state; authority=this; question=what handle lists and revokes this token?';
COMMENT ON COLUMN zz.pat.principal_id IS 'class=relation; authority=this; question=whose authority does this token carry?';
COMMENT ON COLUMN zz.pat.token_hash IS 'class=current_state; authority=this; question=what is the sha256 of this token''s bearer secret?';
COMMENT ON COLUMN zz.pat.label IS 'class=current_state; authority=this; question=what purpose does this token serve, and what is it displayed as?';
COMMENT ON COLUMN zz.pat.team_id IS 'class=relation; authority=this; question=which team is this token confined to, if any?';
COMMENT ON COLUMN zz.pat.expires_at IS 'class=current_state; authority=this; question=when does this token stop working?';
COMMENT ON COLUMN zz.pat.revoked_at IS 'class=current_state; authority=this; question=when was this token revoked?';
COMMENT ON COLUMN zz.pat.last_used_at IS 'class=current_state; authority=this; question=when did this token last authenticate?';
COMMENT ON COLUMN zz.pat.created_at IS 'class=current_state; authority=this; question=when was this token issued?';
COMMENT ON COLUMN zz.pat.oauth_client_id IS 'class=relation; authority=this; question=which registered OAuth client was this token minted for?';

COMMENT ON TABLE zz.plugin IS 'class=current_state; authority=this; question=which plugins the platform knows, whether each is ours or a third party''s, and which team maintains it?';
COMMENT ON COLUMN zz.plugin.id IS 'class=current_state; authority=this; question=what is this plugin''s stable identity, the row its versions, protocol versions and release authority hang from?';
COMMENT ON COLUMN zz.plugin.name IS 'class=current_state; authority=this; question=what is this plugin''s unique name, the external address that IDENTIFY and the console resolve through?';
COMMENT ON COLUMN zz.plugin.origin IS 'class=current_state; authority=this; question=is this plugin one the platform released or a third-party capture, the fact that decides which registration path may write it?';
COMMENT ON COLUMN zz.plugin.owner_team_id IS 'class=relation; authority=this; question=which team maintains this plugin, a display fact that grants no release authority?';

COMMENT ON TABLE zz.plugin_release_owner IS 'class=relation; authority=this; question=which teams'' members may approve and apply a release of which plugin?';
COMMENT ON COLUMN zz.plugin_release_owner.plugin_id IS 'class=relation; authority=this; question=which plugin does this release authority belong to?';
COMMENT ON COLUMN zz.plugin_release_owner.team_id IS 'class=relation; authority=this; question=which team holds this plugin''s release authority?';

COMMENT ON TABLE zz.plugin_tool IS 'class=immutable_history; authority=this; question=which MCP tool names, and on which door, did this plugin version serve, captured at boot so it cannot be rebuilt without booting that build again?';
COMMENT ON COLUMN zz.plugin_tool.plugin_version_id IS 'class=relation; authority=this; question=which plugin version served this tool?';
COMMENT ON COLUMN zz.plugin_tool.name IS 'class=immutable_history; authority=this; question=what tool name did this plugin version serve?';
COMMENT ON COLUMN zz.plugin_tool.door IS 'class=immutable_history; authority=this; question=which door served this tool, a fact that stays true history after a door moves elsewhere?';

COMMENT ON TABLE zz.plugin_version IS 'class=immutable_history; authority=this; question=which plugin was released as which version with which content digest, written once and never rewritten?';
COMMENT ON COLUMN zz.plugin_version.id IS 'class=immutable_history; authority=this; question=which released plugin version do its tools, skill memberships, observation snapshots and evaluation subjects hang from?';
COMMENT ON COLUMN zz.plugin_version.plugin_id IS 'class=relation; authority=this; question=which plugin was this version released from?';
COMMENT ON COLUMN zz.plugin_version.version IS 'class=immutable_history; authority=this; question=which version did the plugin declare for this release?';
COMMENT ON COLUMN zz.plugin_version.digest IS 'class=immutable_history; authority=this; question=what content digest did the release vouch for these exact bytes, the identity an evaluation subject is compared against?';
COMMENT ON COLUMN zz.plugin_version.released_at IS 'class=immutable_history; authority=this; question=when was this version first registered, the release order that version strings cannot give once a plugin has been renumbered?';
COMMENT ON COLUMN zz.plugin_version.component_manifest IS 'class=immutable_history; authority=this; question=which components made up this version of a third-party capture, null for a catalog release?';
COMMENT ON COLUMN zz.plugin_version.source_locator IS 'class=immutable_history; authority=this; question=where was this third-party capture taken from, null for a catalog release?';
COMMENT ON COLUMN zz.plugin_version.tree_digest IS 'class=immutable_history; authority=this; question=what digest did the captured source tree have, null for a catalog release?';
COMMENT ON COLUMN zz.plugin_version.resolved_commit IS 'class=immutable_history; authority=this; question=which commit was the captured source resolved to, null for a catalog release?';

COMMENT ON TABLE zz.plugin_version_skill IS 'class=relation; authority=this; question=which skill version did each plugin version ship?';
COMMENT ON COLUMN zz.plugin_version_skill.plugin_version_id IS 'class=relation; authority=this; question=which plugin version shipped this skill version?';
COMMENT ON COLUMN zz.plugin_version_skill.skill_version_id IS 'class=relation; authority=this; question=which version of the skill did this plugin version ship?';
COMMENT ON COLUMN zz.plugin_version_skill.skill_id IS 'class=relation; authority=this; question=which skill does this membership bind, the key column that stops one plugin version binding two versions of the same skill?';

COMMENT ON TABLE zz.principal IS 'class=current_state; authority=this; question=who is known to the platform, with what platform authority, whether they may act, and which team they chose to act for?';
COMMENT ON COLUMN zz.principal.id IS 'class=current_state; authority=this; question=what is this person''s stable identity?';
COMMENT ON COLUMN zz.principal.email IS 'class=current_state; authority=this; question=what login address resolves this person at every door?';
COMMENT ON COLUMN zz.principal.display_name IS 'class=current_state; authority=this; question=what human name is this person shown under?';
COMMENT ON COLUMN zz.principal.role IS 'class=current_state; authority=this; question=what platform-wide authority does this person hold?';
COMMENT ON COLUMN zz.principal.status IS 'class=current_state; authority=this; question=may this person act at all?';
COMMENT ON COLUMN zz.principal.created_at IS 'class=current_state; authority=this; question=when was this person added?';
COMMENT ON COLUMN zz.principal.active_team_id IS 'class=relation; authority=this; question=which team has this person chosen to act for?';

COMMENT ON TABLE zz.release_attempt IS 'class=state_machine; authority=this; question=what became of one attempt to promote one candidate — applied, refused, failed or rolled back — and did real use after the release establish it?; transitions=prepared->applying,applying->released,applying->failed,prepared->refused,released->rolled_back';
COMMENT ON COLUMN zz.release_attempt.id IS 'class=state_machine; authority=this; question=what is this attempt''s stable identity, the row its required owners, audit and verdict hang from?';
COMMENT ON COLUMN zz.release_attempt.candidate_id IS 'class=relation; authority=this; question=which candidate it releases, the parent the console''s newest-attempt query orders by?';
COMMENT ON COLUMN zz.release_attempt.status IS 'class=state_machine; authority=this; question=where does it stand — prepared, applying, released, refused, failed or rolled back — the field every reader of the promotion boundary gates on?';
COMMENT ON COLUMN zz.release_attempt.released_plugin_version_id IS 'class=relation; authority=this; question=which released plugin version it published, never null exactly when the status is released or rolled_back?';
COMMENT ON COLUMN zz.release_attempt.release_ref IS 'class=state_machine; authority=this; question=which 40-hex commit the release tag names, null until a release lands?';
COMMENT ON COLUMN zz.release_attempt.verification IS 'class=state_machine; authority=this; question=what evidence does the verdict rest on — {post_release_runs, released_eval_run_id, released_overall, base_eval_run_id, base_overall, delta, regression_band, guardrail_status} — null until the released subject has enough real runs and an evaluation to judge, the verdict itself being the verdict column and when it landed being verified_at?';
COMMENT ON COLUMN zz.release_attempt.created_at IS 'class=state_machine; authority=this; question=when was it prepared, the order the console prints attempts in?';
COMMENT ON COLUMN zz.release_attempt.reason IS 'class=state_machine; authority=this; question=why did this attempt end as it did — releaseDecision''s own reason on a refusal, the failing command''s output tail (release_record) on a failure, the operator''s reason on a rollback, or the accepted override (--reconcile --accept-tag-without-candidate-commit) on a reconciled release — null for prepared and applying, and for a release proved without an override?';
COMMENT ON COLUMN zz.release_attempt.plugin_id IS 'class=relation; authority=this; question=which plugin this attempt releases — the base subject''s own plugin, written by release_prepare — the column keying the index that allows at most one applying attempt per plugin?';
COMMENT ON COLUMN zz.release_attempt.applying_at IS 'class=state_machine; authority=this; question=when did release_apply move it to applying, an attempt still applying long after the CLI''s own gate and release timeouts being stale and named by release_apply for reconciliation?';
COMMENT ON COLUMN zz.release_attempt.verdict IS 'class=state_machine; authority=this; question=what did the post-release check decide — established, rolled_back or not_established — null until real use of the released version has been judged?';
COMMENT ON COLUMN zz.release_attempt.verified_at IS 'class=state_machine; authority=this; question=when was that verdict recorded?';
COMMENT ON COLUMN zz.release_attempt.applied_by IS 'class=state_machine; authority=this; question=which principal''s release_apply moved it to applying, since release_record and release_verify accept that principal or a member of a required owner team and nobody else?';

COMMENT ON TABLE zz.release_attempt_owner IS 'class=relation; authority=this; question=which teams'' members must approve and apply a release attempt before it may cross the promotion boundary?';
COMMENT ON COLUMN zz.release_attempt_owner.release_attempt_id IS 'class=relation; authority=this; question=which release attempt does this required-owner row gate?';
COMMENT ON COLUMN zz.release_attempt_owner.team_id IS 'class=relation; authority=this; question=which team''s members may approve that attempt, resolved live from the base subject''s own release owners when it was prepared?';

COMMENT ON TABLE zz.skill IS 'class=current_state; authority=this; question=which skill names has the catalog ever shipped, which flow each is a step of, and which are no longer in the catalog?';
COMMENT ON COLUMN zz.skill.id IS 'class=current_state; authority=this; question=what is this skill''s stable identity, the row its versions and every attribution through them hang from?';
COMMENT ON COLUMN zz.skill.name IS 'class=current_state; authority=this; question=what is this skill''s catalog name, the external address that is unique across the whole catalog?';
COMMENT ON COLUMN zz.skill.flow IS 'class=current_state; authority=this; question=which flow manifest names this skill as one of its steps, null when it is a plugin skill rather than a flow step, and the fact a subject''s profile filters on to exclude a flow''s own skills?';
COMMENT ON COLUMN zz.skill.retired IS 'class=current_state; authority=this; question=is this skill no longer in the catalog, a flag whose identity row survives because runs and documents still attribute to its versions?';

COMMENT ON TABLE zz.skill_run IS 'class=current_state; authority=this; question=what has one caller conversation done with one skill version inside one initiative — how many calls, how many refusals, how much response body, and from when to when?; retention=follows event: never pruned on its own, and once raw telemetry ages out the summary stays the durable answer for its window';
COMMENT ON COLUMN zz.skill_run.id IS 'class=current_state; authority=this; question=what this run''s stable identity is, the one an evaluation cites as run:<uuid> and an event points at as its run_id?';
COMMENT ON COLUMN zz.skill_run.initiative_id IS 'class=relation; authority=this; question=which initiative this run happened in, null for the 96 runs whose calls belonged to no initiative?';
COMMENT ON COLUMN zz.skill_run.skill_version_id IS 'class=relation; authority=this; question=which skill version the run used, time-bound to the version current at the events it groups, never null?';
COMMENT ON COLUMN zz.skill_run.session IS 'class=current_state; authority=this; question=what conversation key this run groups, the same key its events carry, never the empty string?';
COMMENT ON COLUMN zz.skill_run.calls IS 'class=current_state; authority=this; question=how many events this run holds, maintained from the run''s own events and changed only when the aggregate changes?';
COMMENT ON COLUMN zz.skill_run.refusals IS 'class=current_state; authority=this; question=how many of this run''s events did not work, maintained from the run''s own events and never more than its calls?';
COMMENT ON COLUMN zz.skill_run.bytes_total IS 'class=current_state; authority=this; question=what the sum of response_bytes over the run''s events is, null when no event in the run was measured and distinct from 0, which means measured and empty, while the zeros written before migration 051 are ambiguous and were deliberately not converted?';
COMMENT ON COLUMN zz.skill_run.started_at IS 'class=current_state; authority=this; question=when this run''s first event happened, the min of its events'' ts?';
COMMENT ON COLUMN zz.skill_run.ended_at IS 'class=current_state; authority=this; question=when this run''s last event happened, the max of its ts, never null so that a run always reads as closed?';
COMMENT ON COLUMN zz.skill_run.team_id IS 'class=relation; authority=this; question=which team owns this run, taken from its events so that the 96 initiative-less runs are visible in team scope too?';

COMMENT ON TABLE zz.skill_version IS 'class=immutable_history; authority=this; question=what exact bytes of a skill were registered as which version, the only surviving record of them because git history is deliberately destroyed?';
COMMENT ON COLUMN zz.skill_version.id IS 'class=immutable_history; authority=this; question=which released skill version does a run, a document or a plugin membership attribute to?';
COMMENT ON COLUMN zz.skill_version.skill_id IS 'class=relation; authority=this; question=which skill does this released version belong to?';
COMMENT ON COLUMN zz.skill_version.version IS 'class=immutable_history; authority=this; question=which version string did the skill declare when this row was registered?';
COMMENT ON COLUMN zz.skill_version.content_hash IS 'class=immutable_history; authority=this; question=what is the whole-file identity of the released SKILL.md, where a legacy <size>-<hex> value predates the sha256 format, is already baked into a subject digest, and so must never be rewritten even though the sha256 check binds only later rows?';
COMMENT ON COLUMN zz.skill_version.released_at IS 'class=immutable_history; authority=this; question=when was this version first registered, the only ''live from'' anchor for the bytes it names?';
COMMENT ON COLUMN zz.skill_version.body_hash IS 'class=immutable_history; authority=this; question=what is the sha256 of the SKILL.md below its frontmatter, so equal hashes say a version bump changed only the frontmatter, and no reader can recompute it once git history is gone?';

COMMENT ON TABLE zz.team IS 'class=current_state; authority=this; question=what tenant exists under which slug, is it live or archived, and who created it?';
COMMENT ON COLUMN zz.team.id IS 'class=current_state; authority=this; question=what is this tenant''s stable identity?';
COMMENT ON COLUMN zz.team.slug IS 'class=current_state; authority=this; question=what is this team''s external address and artifact-store directory name?';
COMMENT ON COLUMN zz.team.name IS 'class=current_state; authority=this; question=what display name is this team shown under?';
COMMENT ON COLUMN zz.team.status IS 'class=current_state; authority=this; question=is this team live or archived?';
COMMENT ON COLUMN zz.team.created_by IS 'class=current_state; authority=this; question=which principal created this tenant?';
COMMENT ON COLUMN zz.team.created_at IS 'class=current_state; authority=this; question=when was this tenant created?';
