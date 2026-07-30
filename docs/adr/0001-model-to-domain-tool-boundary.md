# ADR 0001: Model-to-domain tool boundary

## Status

Accepted

## Decision

Authorized Telegram text reaches Eve without intent-specific interception. The
model interprets natural language and emits a provider-neutral, schema-validated
tool call. A domain module applies deterministic semantic and policy validation,
then a provider adapter performs the external API operation.

For Calendar reads, the public tool is `list_calendar_events`. Its period is one
of remainder-of-today, today, tomorrow, an ISO date, or an inclusive ISO date
range. Calendar resolves exact timezone boundaries, rejects invalid periods and
ranges longer than 31 days, and returns minimal structured Events plus the
resolved period. The Google adapter paginates without silently truncating valid
ranges.

The model asks a clarification question when natural-language intent is
materially ambiguous. Read operations need no approval prompt, but tools enforce
Owner authorization independently of channel ingress.

## Consequences

Natural-language capability improves with the model without expanding provider
adapters or adding regex parsers. Calendar semantics remain deterministic and
testable. Future providers can implement the Calendar adapter, while future
Tasks tools remain in their own domain. Multi-provider aggregation is not part
of this decision.
