# Task Proposal approval boundary

## Status

Accepted

## Decision

Google Task creation follows the Event Proposal approval boundary with three
provider-neutral preparation tools plus the approved write tool. `prepare_task` is structurally limited to a required
title and always produces an undated, notes-free Proposal. The model cannot add
defaults through this path. `prepare_dated_task` requires a date-only due date
and structurally cannot accept notes. `prepare_noted_task` requires meaningful
notes that the Owner explicitly requested and optionally accepts an explicitly
requested date-only due date. All three produce an immutable Task Proposal.
`create_task` accepts that complete
Proposal, requires Eve approval on every call, revalidates its identity and
Owner authorization, and writes exactly the displayed fields to the configured
Tasks list.

The Eve call ID identifies one execution. In-process repeated delivery shares
the same pending or completed insert. Eve's durable action state remains the
primary retry boundary across processes because Google Tasks does not accept a
client-supplied idempotency key.

If an insert has an ambiguous transport or server outcome, the Google adapter
performs one narrow recovery query: Tasks updated within five seconds of the
attempt are compared against the exact title, notes, and date-only due value.
Exactly one match confirms creation. Zero or multiple matches remain an error;
Bud does not retry the insert or claim success. Authentication, authorization,
and rate-limit failures never use this duplicate guard.

## Consequences

Changing any displayed field creates a different Proposal identity and needs
fresh approval. Undated Tasks remain undated. A requested time cannot enter a
Task Proposal; Bud explains Google's date-only limitation and offers an Event
Proposal instead. The narrow recovery query reduces ambiguous duplicates but
cannot provide provider-native idempotency after process loss.
