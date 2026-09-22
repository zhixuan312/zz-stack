/**
 * The public claim handler re-derives, and refuses a record that no longer describes its
 * decision — proved by producing each condition rather than by reading for it.
 *
 * WHY THIS IS A SECOND CHECK, beside `issuer-unreachable.ts`. That one asks whether issuance
 * is reachable and whether a fabricated id redeems. Both are questions about the ISSUING side
 * and about a name. This one is about the REDEEMING side: a grant that was validly issued,
 * against a world that then moved under it. No amount of issuance-side checking demonstrates
 * it, which is the argument `ProbeableGrantStore` is declared with — `tamper`, `advance` and
 * `withdrawApproval` exist for exactly this and for nothing else.
 *
 * EVERY CASE CARRIES ITS CONTROL. A refusal is evidence only if the same claim redeems in an
 * unperturbed world, so each case issues twice: once clean, which must succeed, and once
 * perturbed, which must refuse. A handler that refused everything would otherwise pass every
 * line below, and that is the failure this shape is written against.
 *
 * THE REASON IS ASSERTED, NOT JUST THE REFUSAL. Seven conditions all deny, and a handler that
 * denied all seven at the first guard would look identical from `ok: false` alone. Matching a
 * fragment of each reason is what makes them seven results rather than one.
 *
 * THE WORLD IS RESET AT BOTH ENDS. `control-grant-fixture.ts` holds one module-scope world on
 * purpose, so a check that advanced an epoch and walked away would hand the next check a world
 * its own assertions were not written against.
 */
import {
  callTool, grantFixtureWorld, issueForTest, resetGrantFixture, type FixtureWorld,
} from "@zz/contracts";
import { check } from "../run.ts";

/** A fresh world with one valid repair grant filed in it. The id and the issuing digest come
 *  back because two of the perturbations below need them and neither is a constant a caller
 *  is given. */
function freshGrant(): { world: FixtureWorld; id: string; digest: string } | string {
  resetGrantFixture();
  const world = grantFixtureWorld();
  const issued = issueForTest({ trustedHost: true, decisionId: "d1" });
  if (!issued.ok) return `issuing the repair grant failed (${issued.reason})`;
  return { world, id: issued.grant.id, digest: issued.grant.issuer_component_digest };
}

/** Redeem through the door, at the revision the seeded world puts the target at. */
const claim = (id: string): { ok: boolean; reason?: string } =>
  callTool("member", "action_claim", { grant_id: id, expected_revision: 4 });

/** One condition: what it is, how to produce it, and a fragment of the reason owed for it. */
interface Case {
  readonly what: string;
  readonly produce: (world: FixtureWorld, id: string, digest: string) => void;
  readonly reason: string;
}

const CASES: readonly Case[] = [
  { what: "a target list widened after issuance",
    produce: (w, id) => w.store.tamper(id, {
      targets: ["record/existing/w1#repair", "record/existing/w1#publish"] }),
    reason: "widening" },
  { what: "an effect digest the stored decision does not produce",
    produce: (w, id) => w.store.tamper(id, { effect_digest: "0".repeat(64) }),
    reason: "altered after" },
  { what: "a dependency that moved after the decision was taken",
    produce: (w) => w.store.advance("dependency", "dep.alpha"),
    reason: "no longer holds" },
  { what: "a permission epoch that moved under the grant",
    produce: (w) => w.store.advance("epoch"),
    reason: "permissions changed under it" },
  { what: "an issuer approval withdrawn after issuance",
    produce: (w, _id, digest) => w.store.withdrawApproval(digest),
    reason: "does not approve" },
  { what: "a grant whose life has run out",
    produce: (w) => { w.now = 2_000_000; },
    reason: "expired" },
  { what: "a target the caller read at an earlier revision",
    produce: (w) => w.store.advance("target", "record/existing/w1#repair"),
    reason: "moved since the caller read it" },
];

check("a grant stops redeeming when the world it was decided over moves", () => {
  const bad: string[] = [];
  for (const c of CASES) {
    const control = freshGrant();
    if (typeof control === "string") { bad.push(control); break; }
    const redeemed = claim(control.id);
    if (!redeemed.ok) {
      bad.push(`the control for "${c.what}" was refused in an unperturbed world ` +
               `(${redeemed.reason}) — a refusal below would then be evidence of nothing`);
      break;
    }
    const perturbed = freshGrant();
    if (typeof perturbed === "string") { bad.push(perturbed); break; }
    c.produce(perturbed.world, perturbed.id, perturbed.digest);
    const out = claim(perturbed.id);
    if (out.ok) bad.push(`action_claim redeemed a grant against ${c.what}`);
    else if (!(out.reason ?? "").includes(c.reason)) {
      bad.push(`${c.what} was refused for the wrong reason, so the guard that fired is not ` +
               `the guard under test: ${out.reason}`);
    }
  }

  // A LEASE IS NOT A MUTATION GRANT, and this is the one case with nothing to perturb: the
  // decision itself says `holds: "lease"`, so a validly issued, entirely fresh grant against
  // it must still refuse. It sits here rather than in CASES because its control is the repair
  // grant already redeemed above — d1 and d2 name the same target and differ only in what
  // they hold.
  if (!bad.length) {
    resetGrantFixture();
    const lease = issueForTest({ trustedHost: true, decisionId: "d2" });
    if (!lease.ok) bad.push(`issuing the lease grant failed (${lease.reason})`);
    else {
      const out = claim(lease.grant.id);
      if (out.ok) bad.push("a lease grant redeemed as a mutation");
      else if (!(out.reason ?? "").includes("lease is not a mutation grant")) {
        bad.push(`the lease grant was refused for the wrong reason: ${out.reason}`);
      }
    }
  }

  resetGrantFixture();
  return bad.length ? bad[0] : null;
});
