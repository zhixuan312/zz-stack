# What each building block can actually do

The judge reads this file when it decides whether a selection chose the right technology. It is
prose rather than a tool dump on purpose: `list_records` tells you a call exists, not that casebox is
where case work belongs, and "right technology" is a judgement about fit, not about whether a
function name appears somewhere.

Keep it honest about limits. A capability sheet that only lists strengths turns every judgement
into "yes, that could work" — which is how a selection step comes to pick three blocks for a
brief that needed none.

## casebox — case management

Work that arrives, is owned by somebody, moves through states and closes. Cases carry a type, a
status, an owner and free-form tags; a case has a correspondence thread and a comment history;
reports count cases and measure how long they sat in each state.

casebox RUNS ITS OWN AUTOMATION, and missing that is the most expensive mistake a reader of this
sheet can make: it fires on a case event or on a clock, checks conditions, updates the case,
reassigns it and sends mail — with nothing else involved. A selection that reaches for a
workflow engine to do what casebox already does has chosen two systems where one would serve,
and the judge should say so.

Good fit: anything with a queue and an owner, where the unit of work has a lifecycle and someone
is accountable for it. Poor fit: booking a room; and orchestration that has to reach a system
casebox cannot see, which is the boundary where reaching for RuleMill becomes correct rather
than redundant.

## bookit — bookable services and slots

A catalogue of bookable services, each with the fields a person must supply; slot availability
over a date range; making, changing and cancelling a booking; the rules around a slot (capacity,
lead time, who may book).

Good fit: facilities, appointments, courses, anything where a finite slot is claimed. Poor fit:
open-ended casework with no slot, and any approval chain more elaborate than a booking's own
status.

## RuleMill — workflow automation

A workflow engine: named workflows built from typed nodes, published or draft, triggered on a
schedule or an event, with nodes that can call another system over HTTP. This is the only block
that can *join* the other two, or reach anything outside them.

Reach for RuleMill when the work CROSSES a boundary the owning block cannot: joining casebox to bookit,
calling something outside both, or running a schedule over data that lives somewhere with no
scheduler of its own — bookit has no automation, so a reminder about a booking needs RuleMill,
while the identical reminder about a case does not.

Good fit: multi-system orchestration, inbound and outbound HTTP, scheduled work over a block that
cannot schedule. Poor fit: being the system of record, and automation that the owning block
already does natively. RuleMill moves and decides; it does not hold the case or own the slot.

## The honest gap

Nothing here does documents-and-signatures, payments, identity verification, GIS or realtime
telemetry. A brief that needs one of those needs a block we do not have, and the correct
selection is to say so rather than to assemble the three we do have into something adjacent.
