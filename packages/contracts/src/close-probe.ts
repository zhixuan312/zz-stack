/**
 * PLANTING EACH FAULT close.ts CLAIMS TO PREVENT, AND WATCHING THE PREVENTION HOLD.
 *
 * Every negative answer that module gives — `acceptedByHand`, `ok`, `proposedIsEnforced`,
 * `observedImpact` — is a refusal, and a refusal nobody has watched fail is a refusal nobody
 * has tested. A flag hard-wired to the comfortable answer passes every test that only ever
 * asks it for the comfortable answer. So each row below runs its detector TWICE: once on a
 * subject where it must stay SILENT, and once with a fault planted, where it must FIRE. A row
 * whose `fires` is false is a finding about close.ts, not about its subject.
 *
 * THE SILENT HALF IS NOT A FORMALITY HERE. A close that refused everything would satisfy every
 * faulted column in this table and be useless — worse than useless, since work that really did
 * finish would become unclosable, which is exactly the mistake that got the read-back check on
 * the proposed count removed in the first place. So every row's healthy column is a close or a
 * handover that SHOULD go through, and it is the half that keeps the other half honest.
 *
 * TWO KINDS OF PLANTED FAULT, AND THE SECOND IS THE INTERESTING ONE.
 *
 * Where a caller can reach the flattering answer by what they pass, the fault is planted in
 * the call: an outcome supplied by hand, a stage handed a state it did not earn, a second
 * closing record. The detector fires by refusing, and the faulted column shows the refusal.
 *
 * Where NO input can reach it — nothing a caller passes can make `proposedIsEnforced` true or
 * turn a forecast into a measurement, because those follow from which builder the value was
 * routed through in code — the fault is planted as a WRONG IMPLEMENTATION, written out here in
 * full, and the row shows that implementation producing the flattering answer on the very
 * declaration where the real one refuses to. That is the only honest way to watch a structural
 * guarantee fire, and it is deliberately not a copy of the real derivation: this file
 * reimplements the mistake rather than importing the mechanism, so a probe cannot go green by
 * sharing the assumption it is supposed to be testing.
 *
 * NOTHING HERE IS A MEASUREMENT. Every count, reason and acceptor below is invented material
 * chosen to make one distinction visible.
 */
import {
  closeInitiative,
  deriveOutcome,
  handoverClaims,
  type Claim,
  type ClaimBasis,
  type CloseRequest,
  type HandoverDeclaration,
  type StageEvidence,
  type StageRecord,
} from "./close.js";

/** One detector, watched on a healthy subject and on a faulted one. `fires` is true only when
 *  it stayed silent on the first and spoke on the second — either half failing makes the
 *  detector worthless, and for opposite reasons. */
export interface CloseProbeRow {
  readonly detector: string;
  readonly healthy: string;
  readonly faulted: string;
  readonly fires: boolean;
}

const row = (
  detector: string,
  healthy: [boolean, string],
  faulted: [boolean, string],
): CloseProbeRow => Object.freeze({
  detector,
  healthy: `${healthy[0] ? "silent" : "MISFIRED"} — ${healthy[1]}`,
  faulted: `${faulted[0] ? "fires" : "MISSED"} — ${faulted[1]}`,
  fires: healthy[0] && faulted[0],
});

/** A request as it arrives from a document rather than from a compiler: the cast is the fault
 *  being planted, and it is the only way to express a caller that writes what the platform
 *  derives, because {@link CloseRequest} has no field for it. */
const asRequest = (raw: Record<string, unknown>): CloseRequest => raw as unknown as CloseRequest;

/** Two opaque stage names. They are letters on purpose: this probe knows no more about what a
 *  stage is than the module it exercises does. */
const EARLIER = "S1";
const LATER = "S2";
/** A third name, for a stage the caller records NOTHING about. It is what makes the append
 *  path — the one an abandoned close takes for the stage it stopped at — reachable in the
 *  fixture at all: a reached stage that already appears among the caller's own records is
 *  never appended, so using one to stand for both hides the append entirely. */
const UNREACHED = "S3";

// ── the faults that no input can reach, written out as the wrong implementation ────────────

/**
 * THE WRONG STAGE RECORD: state set beside the evidence instead of from it.
 *
 * This is the shape close.ts exists to prevent, and it is four lines long — which is the point.
 * Nothing about it looks careless. It simply trusts a `state` that arrived with the record,
 * and that is all it takes for a close to assert that work nobody has evidence for succeeded.
 */
function faultedStageRecord(record: StageEvidence & { readonly state?: string }): StageRecord {
  return Object.freeze({
    step: record.step,
    state: (record.state === "established" ? "established" : "not_established"),
    evidence: Object.freeze([...(record.evidence ?? [])]),
  });
}

/**
 * THE WRONG CLAIM BASIS: a declared count routed through the reader's door.
 *
 * The flattering version of a handover is one line different from the honest one — the count
 * the author typed, stamped with the name of something that never read it back.
 */
function faultedProposedClaim(declaration: HandoverDeclaration): Claim {
  const basis: ClaimBasis = "read-back";
  return Object.freeze({ field: "proposed_team_nodes", value: String(declaration.proposed_team_nodes), basis });
}

/**
 * THE NARROW READING UNDER A GENERAL NAME — the fault this module actually shipped with, and
 * the reason this row exists.
 *
 * `selfReported` once answered "is the PROPOSED COUNT the author's word", under a name that
 * promises "does this handover assert anything nobody read back". Every call that declared no
 * count therefore reported `selfReported: false` while self-reporting everything it had. It
 * passed the declared check the whole time, because that check only ever asks about a
 * declaration that HAS a count — which is what a flag nobody has watched be wrong looks like.
 */
function faultedSelfReported(claims: readonly Claim[]): boolean {
  return claims.find((c) => c.field === "proposed_team_nodes")?.basis === "self-reported";
}

/**
 * THE SECOND PREDICATE: the forecast read off the declaration again, beside the claim that
 * already holds it. Two readings of one fact, free to disagree — here, over whitespace, which
 * the claim builder discards and this does not.
 */
function faultedForecast(declaration: HandoverDeclaration): string | null {
  return declaration.expectedImpact ?? null;
}

/** THE WRONG IMPACT: the forecast, relabelled. Nobody measured anything. */
function faultedObservedImpact(declaration: HandoverDeclaration): string | undefined {
  return declaration.expectedImpact;
}

// ── the rows ───────────────────────────────────────────────────────────────────────────────

function outcomeRows(): readonly CloseProbeRow[] {
  const honest = closeInitiative({ disposition: "finished", accepted_by: "the stakeholder" });
  const smuggledUnderAName = closeInitiative(asRequest({ disposition: "finished", note: "it went well" }));
  // The read-set drift case, stated as a subject rather than left to be inferred: `abandoned`
  // is BOTH a disposition and an outcome word, so a scan that reached a field this module
  // reads would refuse every abandoned close ever made. It is the one input that tells the
  // destructure's leftovers apart from a list of key names somebody maintains.
  const alsoAnOutcomeWord = closeInitiative({ disposition: "abandoned", reachedStage: LATER });
  const byHand = closeInitiative(asRequest({ disposition: "finished", outcome: "accepted" }));
  const underAnotherKey = closeInitiative(asRequest({ disposition: "finished", finalState: "delivered" }));

  const known = deriveOutcome({ disposition: "finished" }) === "delivered"
    && deriveOutcome({ disposition: "abandoned" }) === "abandoned";
  const unknown = deriveOutcome(asRequest({ disposition: "probably" }));
  const unknownClose = closeInitiative(asRequest({ disposition: "probably" }));

  return [
    row("an outcome supplied by hand rather than derived",
      [!honest.acceptedByHand && honest.ok && honest.outcome === "accepted"
        && honest.accepted_by === "the stakeholder"
        && !smuggledUnderAName.acceptedByHand && smuggledUnderAName.ok,
        "a close that names its acceptor is accepted, and an unread field whose text merely " +
        "reads well is not mistaken for a verdict"],
      [byHand.acceptedByHand && !byHand.ok && byHand.outcome === null && byHand.stages.length === 0
        && byHand.refusals.some((r) => r.includes("outcome")),
        "the supplied outcome is observed, the close is refused, and the refusal carries no " +
        "partial record for a later reader to mistake for a whole one"]),
    row("an outcome smuggled in under a key nobody reads",
      [honest.ok && !alsoAnOutcomeWord.acceptedByHand && alsoAnOutcomeWord.ok
        && alsoAnOutcomeWord.outcome === "abandoned",
        "the same close with nothing smuggled goes through, and a close whose DISPOSITION is " +
        "itself an outcome word is not mistaken for one: the scan sees only fields this " +
        "module does not read"],
      [underAnotherKey.acceptedByHand && !underAnotherKey.ok
        && underAnotherKey.refusals.some((r) => r.includes("finalState")),
        "a verdict under an invented key name is caught by its VALUE and named in the " +
        "refusal, because the scan is the destructure's leftovers rather than a list of keys"]),
    row("an outcome derived from a disposition nobody recognises",
      [known, "both dispositions this platform knows derive their outcome"],
      [unknown === null && !unknownClose.ok && unknownClose.outcome === null,
        "an unrecognised disposition derives nothing and closes nothing, rather than " +
        "defaulting to the outcome that happens to read best"]),
  ];
}

function refusalRows(): readonly CloseProbeRow[] {
  const bare = closeInitiative({ disposition: "finished" });
  const recorded = closeInitiative({ disposition: "finished", gatesRecorded: true });
  const unrecorded = closeInitiative({ disposition: "finished", gatesRecorded: false });
  const second = closeInitiative({ disposition: "finished", already: true });
  const secondWithMaterial = closeInitiative({
    disposition: "abandoned",
    already: true,
    reachedStage: "S2",
    stages: [{ step: "S1", evidence: ["the document it produced"] }],
  });
  const first = closeInitiative({ disposition: "finished", already: false });

  return [
    row("a closing record written twice",
      [first.ok && bare.ok, "a first close goes through, whether or not it says so explicitly"],
      [!second.ok && second.refusals.some((r) => r.includes("revising"))
        && !secondWithMaterial.ok && secondWithMaterial.outcome === null
        && secondWithMaterial.stages.length === 0,
        "a second is refused, the refusal says where a correction actually goes — revising " +
        "the record, not writing the disposition again — and a refusal that HAD stages and " +
        "an outcome to show records neither, because a half-filled record is what a later " +
        "reader mistakes for a whole one"]),
    row("a declared gate left unrecorded",
      [recorded.ok && recorded.gatePosture === "recorded",
        "a close that recorded its gates goes through and says so"],
      [!unrecorded.ok && unrecorded.gatePosture === "unrecorded",
        "a close that declared a gate and did not record it is refused"]),
    row("a gate posture nobody stated, written down as though somebody had",
      [bare.ok && bare.outcome === "delivered",
        "a bare close is not refused: a caller who said nothing declared no gate, so there " +
        "is nothing unrecorded to refuse over"],
      [bare.gatePosture === "unstated" && bare.unstated.includes("gatesRecorded")
        && bare.unstated.includes("no_signoff_reason") && bare.no_signoff_reason === null,
        "what nobody stated is recorded as unstated and listed as a gap — not as recorded, " +
        "which would assert on a silent caller's behalf, and not as unrecorded, which would " +
        "make work that declared no gates impossible to close"]),
  ];
}

function stageRows(): readonly CloseProbeRow[] {
  const evidenced: StageEvidence = { step: EARLIER, evidence: ["the document it produced"] };
  const empty: StageEvidence = { step: LATER, evidence: ["   "] };

  const abandoned = closeInitiative({ disposition: "abandoned", reachedStage: UNREACHED, stages: [evidenced, empty] });
  const reached = abandoned.stages.find((s) => s.step === UNREACHED);
  const earlier = abandoned.stages.find((s) => s.step === EARLIER);

  const claimedByCaller = closeInitiative({
    disposition: "abandoned",
    reachedStage: LATER,
    stages: [asRequest({ step: LATER, state: "established", evidence: [] }) as unknown as StageEvidence],
  });
  const claimed = claimedByCaller.stages.find((s) => s.step === LATER);

  const faulted = faultedStageRecord({ step: LATER, state: "established", evidence: [] });
  const faultedBlank = faultedStageRecord(empty as StageEvidence & { state?: string });

  const onWhitespace = abandoned.stages.find((s) => s.step === LATER);

  return [
    row("a stage recorded as established without the evidence for it",
      [earlier?.state === "established" && earlier.evidence.length === 1
        && reached?.state === "not_established" && abandoned.ok
        && reached.evidence.length === 0 && abandoned.stages.length === 3,
        "work that stopped still closes: the stage that left a document is established, the " +
        "stage it stopped at is appended with nothing claimed, and no stage beyond the three " +
        "the caller named is invented"],
      [faulted.state === "established" && faulted.evidence.length === 0
        && claimed?.state === "not_established",
        "an implementation that sets the state beside the evidence produces exactly the " +
        "record this refuses — established, nothing behind it — while the real one records " +
        "the caller's identical claim as not_established"]),
    row("a caller's own opinion of a stage's state",
      [earlier?.state === "established",
        "a stage the caller evidenced is established, because the evidence is there"],
      [claimed?.state === "not_established" && faultedBlank.state === "not_established"
        && onWhitespace?.state === "not_established" && onWhitespace.evidence.length === 0
        && faultedStageRecord({ step: LATER, state: "established", evidence: ["  "] }).evidence.length === 1,
        "the claim is dropped on the way in and the state recomputed, and blank text is not " +
        "evidence — where the faulted implementation keeps the whitespace and honours what " +
        "it was told, which is a stage established on nothing at all"]),
  ];
}

function handoverRows(): readonly CloseProbeRow[] {
  const declaration: HandoverDeclaration = { proposed_team_nodes: "2", mintedTeamNodes: 0 };
  const h = handoverClaims(declaration);
  const measured = handoverClaims({ expectedImpact: "fewer repeated questions", impactReading: "3 fewer", impactReadBy: "the console" });
  const forecastOnly = handoverClaims({ expectedImpact: "fewer repeated questions" });
  const readingWithNoReader = handoverClaims({ impactReading: "3 fewer" });
  const mintedRead = handoverClaims({ mintedTeamNodes: 0, mintedReadBy: "the minting record" });

  const faultedProposed = faultedProposedClaim(declaration);
  const faultedImpact = faultedObservedImpact({ expectedImpact: "fewer repeated questions" });

  // Two declarations that carry NO proposed count — the shape the declared check never asks
  // about, and the shape every flag here was silently wrong about.
  const nothingAtAll = handoverClaims({});
  const blankForecast = handoverClaims({ expectedImpact: "   " });
  const readBackOnly = handoverClaims({ mintedTeamNodes: 0, mintedReadBy: "the minting record" });
  // A count the author proposed, ALONGSIDE a different count something really did read back.
  // This is the declaration that tells "the proposed count is enforced" apart from "something
  // around here was read back" — without it, a flag widened to any read-back claim reports
  // this handover's count as enforced and no row notices.
  const proposedBesideARealReading = handoverClaims({
    proposed_team_nodes: "2",
    mintedTeamNodes: 1,
    mintedReadBy: "the minting record",
  });

  return [
    row("a self-reported count presented as enforcement",
      [h.selfReported && !h.proposedIsEnforced
        && h.statement.includes("self-reported and not read back: proposed_team_nodes")
        && !forecastOnly.proposedIsEnforced
        && forecastOnly.claims.every((c) => c.field !== "proposed_team_nodes")
        && !proposedBesideARealReading.proposedIsEnforced
        && proposedBesideARealReading.claims.some((c) => c.basis === "read-back"),
        "the count is carried, labelled as the author's word, and named as unverified in the " +
        "sentence the handover leads with; a handover that declares no count has nothing to " +
        "present as enforced; and a count sitting beside a reading something really did take " +
        "is still not enforced, because that reading was of a different fact"],
      [faultedProposed.basis === "read-back"
        && h.claims.find((c) => c.field === "proposed_team_nodes")?.basis === "self-reported",
        "routing that same count through the reader's door stamps it read-back, where the " +
        "real routing cannot: nothing reads it back, so there is no input that reaches this"]),
    row("expected impact recorded as observed impact",
      [measured.observedImpact === "3 fewer" && measured.expectedImpact === "fewer repeated questions",
        "a real measurement is recorded as observed, and the forecast is kept beside it " +
        "rather than replaced by it"],
      [faultedImpact === "fewer repeated questions" && forecastOnly.observedImpact === undefined
        && forecastOnly.expectedImpact === "fewer repeated questions",
        "an implementation that reads the forecast produces an observation nobody took, " +
        "where the real one leaves observed impact absent"]),
    row("a handover that self-reports everything it has, announcing that it self-reports nothing",
      [forecastOnly.selfReported
        && forecastOnly.claims.every((c) => c.basis === "self-reported")
        && !readBackOnly.selfReported && readBackOnly.claims.length === 1
        && !nothingAtAll.selfReported && nothingAtAll.claims.length === 0
        && h.selfReported,
        "the flag answers the question its name asks, on every input: a handover carrying " +
        "only a forecast says it self-reports something, one whose single claim was read " +
        "back says it does not, and one that claims nothing asserts nothing"],
      [!faultedSelfReported(forecastOnly.claims)
        && forecastOnly.claims.every((c) => c.basis === "self-reported")
        && faultedSelfReported(h.claims),
        "narrowed to the proposed count's basis, the same handover full of the author's own " +
        "words announces that it self-reports nothing — and stays green against a declared " +
        "check that only ever hands it a declaration with a count in it"]),
    row("a forecast field and the forecast claim disagreeing",
      [forecastOnly.expectedImpact === "fewer repeated questions"
        && forecastOnly.expectedImpact
          === (forecastOnly.claims.find((c) => c.field === "expected_impact")?.value ?? null)
        && blankForecast.expectedImpact === null
        && blankForecast.claims.length === 0,
        "the field is the claim's own value, so whitespace is a forecast in neither or both: " +
        "here, in neither"],
      [faultedForecast({ expectedImpact: "   " }) === "   "
        && blankForecast.expectedImpact === null && blankForecast.claims.length === 0,
        "a second reading of the declaration reports a forecast the claims do not hold, which " +
        "is a record disagreeing with itself in the one place a reader checks"]),
    row("a value with nothing named as having read it, stamped read-back",
      [mintedRead.claims.find((c) => c.field === "minted_team_nodes")?.basis === "read-back"
        && mintedRead.statement.includes("read back: minted_team_nodes"),
        "a count with a named reader is read-back, and the statement says which claim that was"],
      [h.claims.find((c) => c.field === "minted_team_nodes")?.basis === "self-reported"
        && readingWithNoReader.observedImpact === undefined,
        "the same count with no reader named degrades to the author's word, and a " +
        "measurement with nobody behind it never becomes an observation"]),
  ];
}

/** Every refusal in close.ts, watched twice. */
export function closeProbe(): readonly CloseProbeRow[] {
  return Object.freeze([...outcomeRows(), ...refusalRows(), ...stageRows(), ...handoverRows()]);
}
