# Multi-Calendar Read Set with one Write Calendar

## Status

Accepted

## Decision

Bud reads an explicit Read Set of up to 10 Google Calendar Sources as one
all-or-nothing Calendar, while retaining one independent Write Calendar as its
timezone authority and future Event-creation destination. Source display names
reach the model, but provider IDs do not. Matching Events from different sources
remain distinct, and source-specific filtering or write-destination selection is
deferred.

## Consequences

Configuration remains predictable and writes cannot drift between Calendars,
but one inaccessible Read Set source makes the complete Calendar read fail. This
deliberately favors truthful completeness over partial availability. Adding a
source increases Google API work, bounded by the 10-source ceiling.
