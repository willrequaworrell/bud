# Bud

Bud is a private Telegram assistant built with Eve. This first slice accepts
text messages only from one configured owner in a private chat and denies all
other Telegram messages before model execution.

## Requirements

- Node.js 24 or newer
- A Telegram bot token and webhook secret
- OAuth credentials and an offline refresh token for one personal Google account
- A Vercel AI Gateway credential available to Eve

Copy `.env.example` to `.env`, fill in the Telegram and Google OAuth values, then
run:

```sh
npm install
npm run dev
```

Register the deployed webhook with Telegram at
`https://<deployment>/eve/v1/telegram`, setting the same
`TELEGRAM_WEBHOOK_SECRET_TOKEN` as Telegram's `secret_token`.

## Security boundary

`TELEGRAM_OWNER_ID` must be the owner's positive numeric Telegram user ID.
Group chats, channels, bots, senders with any other ID, attachments, and empty
messages are dropped by the channel before Eve creates a model turn. Shell,
filesystem, web fetch/search, and delegation tools are disabled explicitly.

Configuration errors name invalid variables but never include their values.

## Calendar reads

Bud combines an explicit Read Set of up to 10 Calendars. Configure their IDs as
a comma-separated `GOOGLE_CALENDAR_READ_IDS`; when omitted, it defaults to
`GOOGLE_CALENDAR_ID`. The latter remains the independent Write Calendar and
supplies Bud's default Calendar timezone. An explicitly configured Read Set does
not automatically include the Write Calendar.

Find a Calendar ID in Google Calendar under **Settings → Settings for my
calendars → Integrate calendar → Calendar ID**. Add the same values to local and
Vercel environment configuration. The OAuth grant must be able to read every
listed Calendar. Bud uses Google's display names in model-visible Event results
and never exposes the configured IDs.

To create Events, authorize the refresh token with read access for the Read Set
and `https://www.googleapis.com/auth/calendar.events.owned`. This limits writes
to Calendars owned by the Google account; Bud further restricts creation to
`GOOGLE_CALENDAR_ID`. Expanding OAuth scopes requires generating a new offline
refresh token, updating `GOOGLE_OAUTH_REFRESH_TOKEN` locally and in Vercel, and
redeploying.

Calendar questions are interpreted by the model, which calls the
provider-neutral `list_calendar_events` tool with a semantic period. The model
can resolve conversational requests such as “Thursday”; it asks for
clarification when the date is materially ambiguous. The Calendar domain then
deterministically validates exact dates, inclusive ranges (up to 31 days), and
IANA timezones before the Google adapter reads every configured source. If any
source fails, Bud returns a safe error instead of presenting an incomplete agenda.

The tool result always includes the resolved date/range and timezone. Calendar
reads are re-authorized inside the tool as well as at Telegram ingress.

## Calendar creation

Bud prepares one immutable timed or all-day Event Proposal before requesting a
write. A missing timed duration defaults to 30 minutes. Google Calendar defaults
supply reminders. Preparation checks the complete Read Set for overlapping
Events, and creation revalidates those conflicts immediately before writing.
Attendees, conferencing, recurrence, and custom reminders are not part of this
slice.

Telegram displays the Event details and any conflict warnings above Eve's native
approval buttons. Approve writes exactly the Proposal to the configured Write
Calendar; Deny writes nothing. A changed conflict requires a fresh Proposal and
approval. While approval is pending, resolve it or use `/reset` before starting
another request.

## Task creation

Bud prepares an immutable Task Proposal containing a required title, optional
notes, and either a date-only due date or `No due date`. Telegram displays every
field before Eve's native approval buttons. Approve writes exactly that Proposal
to the configured Tasks list; Deny writes nothing. Revisions require a new
Proposal and approval, and the same one-pending-Proposal Conversation rule used
by Calendar Events applies.

Google Tasks cannot retain a due time. When a Task request includes a specific
time, Bud explains the limitation and offers a Calendar Event instead of silently
discarding the time. Google Tasks also has no native idempotency key; Eve's
durable execution state is the primary retry protection, with a narrowly bounded
exact-match lookup only after an ambiguous Google insert outcome.

## Verification

```sh
npm test
npm run typecheck
npm run build
```

The tests use the public Telegram Channel harness with a deterministic model.
They deliver representative Bot API updates and assert model calls and outbound
messages without contacting Telegram or a model provider.
