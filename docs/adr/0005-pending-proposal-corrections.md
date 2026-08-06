# Pending Proposal corrections

## Status

Accepted

## Decision

ADR 0001's rule against intent-specific Telegram interception has one narrow exception while a
Conversation has a pending Task or Event Proposal. Owner free text is classified, without tools,
as either a correction to that exact pending Proposal or an unrelated request. Unrelated text
remains refused. Classifier failure also refuses the message.

A correction denies and therefore supersedes the pending approval before the original Owner text
starts a normal Eve turn in the same Conversation. The old Proposal remains unchanged in the
Conversation history. Any revised external write must pass through the existing preparation tool,
produce a new immutable Proposal identity, and request fresh approval under ADR 0003 or ADR 0004.

The classifier receives only the pending Proposal type and fields plus the new Owner text. It does
not rewrite fields, invoke tools, or decide whether a write may proceed.

## Consequences

Corrections such as changing an Event time can retain conversational context without approving a
stale Proposal. General questions cannot bypass Proposal serialization, and classification cannot
weaken the domain-tool approval boundary.
