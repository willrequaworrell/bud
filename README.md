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

Calendar questions are interpreted by the model, which calls the
provider-neutral `list_calendar_events` tool with a semantic period. The model
can resolve conversational requests such as “Thursday”; it asks for
clarification when the date is materially ambiguous. The Calendar domain then
deterministically validates exact dates, inclusive ranges (up to 31 days), and
IANA timezones before the Google adapter reads every configured source. If any
source fails, Bud returns a safe error instead of presenting an incomplete agenda.

The tool result always includes the resolved date/range and timezone. Calendar
reads are re-authorized inside the tool as well as at Telegram ingress.

## Verification

```sh
npm test
npm run typecheck
npm run build
```

The tests use the public Telegram Channel harness with a deterministic model.
They deliver representative Bot API updates and assert model calls and outbound
messages without contacting Telegram or a model provider.
