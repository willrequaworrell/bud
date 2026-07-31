# Event Proposal approval boundary

## Status

Accepted

## Decision

Calendar Event creation uses two provider-neutral tools. `prepare_calendar_event`
normalizes and validates an immutable Event Proposal without writing.
`create_calendar_event` accepts that complete Proposal, requires Eve approval on
every call, revalidates its identity and Owner authorization, and writes exactly
the displayed fields to the configured Write Calendar.

The Eve call ID supplies the provider idempotency key. Google stores a private
hash of the intended Event and an insert conflict is successful only when the
existing Event carries the same hash. A Conversation permits one pending
Proposal; unrelated text is refused until approval, denial, or reset.

## Consequences

Defaults and semantic validation occur before approval, while provider behavior
remains outside the model. Every changed field needs a fresh Proposal and
approval. Native channel approval UI is used first. Conflict detection,
recurrence, attendees, conferencing, custom reminders, and selectable write
destinations remain separate work.
