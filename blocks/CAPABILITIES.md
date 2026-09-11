# What each building block can actually do

The judge reads this file when it decides whether a selection chose the right technology. It is
prose rather than a tool dump on purpose: `get_cases` tells you a call exists, not that casebox is
where case work belongs, and "right technology" is a judgement about fit, not about whether a
function name appears somewhere.

Keep it honest about limits. A capability sheet that only lists strengths turns every judgement
into "yes, that could work" — which is how a selection step comes to pick three blocks for a
brief that needed none.

## casebox — case management

Work that arrives, gets owned by somebody, moves through states, and closes. Cases with types,
statuses, sources, tags and assignees; customers; the email thread attached to a case; comments
and audit history; per-app users and roles; reports over case counts and durations. Workflows
here fire *on a case* — a status change, a schedule — and act within casebox.

casebox RUNS ITS OWN AUTOMATION, and missing this is the most expensive mistake a reader of this sheet
can make. It has a workflow engine, instant and scheduled, that fires on a case event or a clock,
evaluates criteria, updates cases, moves statuses, assigns people and SENDS EMAIL — all without
anything else involved. "There is automation in this requirement" is therefore NOT a reason to
add n8n. A blind reading of these briefs did exactly that and marked two correct single-block
selections as missing a block.

Good fit: complaints, applications, objections, inspections, escalations, anything with a queue
and an owner — including the routing, deadlines, reminders and notifications AROUND that queue.
Poor fit: booking a room, or orchestration that has to reach a system casebox cannot see.

## bookit — bookable services and slots

A catalogue of bookable services, each with the fields a person must supply; slot availability
over a date range; making, changing and cancelling a booking; the rules around a slot (capacity,
lead time, who may book).

Good fit: facilities, appointments, courses, anything where a finite slot is claimed. Poor fit:
open-ended casework with no slot, and any approval chain more elaborate than a booking's own
status.

## n8n — workflow automation

A workflow engine: named workflows built from typed nodes, published or draft, triggered on a
schedule or an event, with nodes that can call another system over HTTP. This is the only block
that can *join* the other two, or reach anything outside them.

Reach for n8n when the work CROSSES a boundary the owning block cannot: joining casebox to bookit,
calling something outside both, or running a schedule over data that lives somewhere with no
scheduler of its own — bookit has no automation, so a reminder about a booking needs n8n,
while the identical reminder about a case does not.

Good fit: multi-system orchestration, inbound and outbound HTTP, scheduled work over a block that
cannot schedule. Poor fit: being the system of record, and automation that the owning block
already does natively. n8n moves and decides; it does not hold the case or own the slot.

## The honest gap

Nothing here does documents-and-signatures, payments, identity verification, GIS or realtime
telemetry. A brief that needs one of those needs a block we do not have, and the correct
selection is to say so rather than to assemble the three we do have into something adjacent.
