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

Bud reads one Calendar, configured by `GOOGLE_CALENDAR_ID` (`primary` by
default). The OAuth grant should be for the personal account that owns that
Calendar and include read-only Google Calendar access. Calendar questions with
no date return the remainder of today in the Calendar's timezone. Bud also
accepts `today`, `tomorrow`, named dates, inclusive date ranges, and explicit
IANA timezones such as `America/Los_Angeles`.

## Verification

```sh
npm test
npm run typecheck
npm run build
```

The tests use the public Telegram Channel harness with a deterministic model.
They deliver representative Bot API updates and assert model calls and outbound
messages without contacting Telegram or a model provider.
