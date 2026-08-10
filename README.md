# Bud

Bud is a private Telegram assistant built with Eve. It accepts text and bounded
Telegram voice notes from one configured Owner in a private chat and denies all
other senders and unsupported media before model execution.

## Requirements

- Node.js 24 or newer
- A Telegram bot token and webhook secret
- OAuth credentials and an offline refresh token for one personal Google account
- A Vercel AI Gateway credential available to Eve
- An OpenAI API key when voice-note transcription is enabled

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
Group chats, channels, bots, senders with any other ID, unsupported attachments,
and empty messages are stopped before Eve creates a model turn. Shell,
filesystem, web fetch/search, and delegation tools are disabled explicitly.

Configuration errors name invalid variables but never include their values.

## Durable creation guard

Automatic creation is protected by an Owner-scoped Upstash Redis rolling window.
Install **Upstash Redis** through the current Vercel Marketplace integration and
allow it to add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to the
deployment. Copy those same variables to local development when exercising the
guard. Do not use retired Vercel KV packages or their `KV_REST_API_*` variables.

If either Upstash variable is absent, invalid, or the service cannot be reached,
Bud safely requests approval instead of granting automatic creation. Existing
creation tools remain approval-gated until their respective policy tickets adopt
the guard.

## Voice notes

Owner voice notes are downloaded from Telegram and sent through a replaceable
transcription adapter before Eve sees the recognized text. Bud immediately shows
`I heard: …`, then handles the transcript in the same durable Conversation and
approval flow as typed input. The default OpenAI adapter uses `OPENAI_API_KEY` and
`gpt-4o-mini-transcribe`; override the model with `BUD_TRANSCRIPTION_MODEL`.

Voice notes default to a 10 MB and five-minute limit. Override these with
`TELEGRAM_VOICE_MAX_BYTES` and `TELEGRAM_VOICE_MAX_DURATION_SECONDS`. Invalid,
oversized, unsupported, failed, or empty transcriptions stop at the channel and
ask for typed input, so they cannot trigger Calendar or Tasks operations. Photos,
documents, video, ordinary audio, and other media are unsupported.

## Siri Shortcut capture

Bud exposes an optional `POST /eve/v1/siri` ingress for a personal Siri
Shortcut. Set `BUD_SIRI_CAPTURE_TOKEN` to a random value containing at least 32
characters; leaving it unset keeps the route disabled. Generate a token with:

```sh
openssl rand -hex 32
```

The Shortcut sends JSON with an `Authorization` bearer header:

```http
POST /eve/v1/siri
Authorization: Bearer <BUD_SIRI_CAPTURE_TOKEN>
Content-Type: application/json

{"message":"Remind me to order furnace filters"}
```

Authenticated, non-empty messages of at most 2,000 characters are accepted
into the Owner's existing private Telegram Conversation. The route responds
immediately with HTTP 202 and a short acknowledgement; Bud's substantive reply,
clarifications, and Approval Requests remain in Telegram. The capture token
cannot itself approve a Calendar or Tasks write.

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

Bud prepares one immutable timed or all-day Prepared Event before requesting a
write. A missing timed duration defaults to 30 minutes. Google Calendar defaults
supply reminders. Preparation checks the complete Read Set for overlapping
Events, and creation revalidates those conflicts immediately before writing.
Events may recur daily, weekly, or monthly with positive intervals and optional
weekly weekday selection. Every recurring Event needs an end date or occurrence count and
is limited to one year and 100 occurrences. Specialized rules and one-off
exceptions are rejected instead of approximated. Attendees, conferencing, and
custom reminders are not part of this slice.

Telegram displays the Prepared Event details and any conflict warnings above
Eve's native Approval Request buttons. Approve writes exactly the Prepared Event
to the configured Write Calendar; Deny writes nothing. A changed conflict
requires a fresh Prepared Event and Approval Request. While an Approval Request
is pending, resolve it or use `/reset` before starting another request.

## Task creation

Bud prepares an immutable Prepared Task containing a required title. By default,
the Task is structurally undated and has no notes; a separate detailed path adds
notes or a date-only due date only when explicitly requested. Telegram displays
every field before Eve's native Approval Request buttons. Approve writes exactly
that Prepared Task to the configured Tasks list; Deny writes nothing. Revisions
require a new Prepared Task and Approval Request. The same rule allowing only
one pending Approval Request per Conversation applies to Calendar Events.

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
