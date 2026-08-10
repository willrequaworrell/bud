# Risk-based Prepared Write execution

## Status

Accepted

## Decision

Bud separates preparation from execution for every external write. Preparation produces one immutable, provider-neutral Prepared Task or Prepared Event; execution revalidates its identity and Owner authorization, uses the Eve call ID for retry protection, and writes exactly the prepared fields. This preserves the validation, bounded recurrence, conflict detection, Google Calendar idempotency, and Google Tasks ambiguous-outcome recovery boundaries established by ADR 0003 and ADR 0004 while replacing their approval-on-every-write policy.

Approval depends on the operation rather than the Conversation channel. One valid Prepared Task, or one nonrecurring Prepared Event on the Write Calendar, may execute automatically. Event overlap and past-time warnings are reported after creation but do not require approval. A recurring Prepared Event requires an Approval Request. Requests for multiple Tasks or Events are clarified into one item before preparation; the write boundary independently permits at most one creation in an Eve turn.

Automatic creation is limited across all channels to ten attempted writes in a rolling ten-minute window, enforced by a durable shared counter whose decisions are idempotent by Eve call ID. Exhausting the limit or being unable to verify it creates an Approval Request instead of failing open. The counter is a loop safeguard, not an authorization mechanism. Future destructive operations, external-recipient actions, and other write classes require their own explicit policies and gain no authority from this decision.

An Approval Request remains bound to the exact Prepared Write. A correction supersedes the pending request and requires a new Prepared Write; unrelated input cannot silently approve it. Telegram remains the durable Conversation and approval surface. Authenticated Siri capture may answer creation-only Approval Requests, including while the phone is locked, but does not establish authority for future approval classes.

## Consequences

Routine capture becomes fire-and-confirm while risky creation shapes retain a durable human checkpoint. Siri and Telegram behave consistently because tools enforce policy below channel ingress. The shared limiter adds a small durable-storage dependency, and creation falls back to approval when that dependency is unavailable. Deployments making the Proposal-to-Prepared Write contract change must first resolve or reset every pending legacy Proposal.
