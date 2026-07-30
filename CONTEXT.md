# Bud context

Bud is a private, reactive Telegram assistant built on Eve. Telegram authenticates
one configured Owner and passes authorized text to the model. The model interprets
natural language and selects typed tools; channels do not duplicate that work
with intent-specific parsers.

## Domain boundaries

- **Calendar** owns provider-neutral event reads, semantic periods, timezone/date
  boundaries, range limits, and safe failures.
- **Google Calendar adapter** translates Calendar requests and results to the
  Google Calendar API. It does not interpret user language.
- **Tasks** will be a separate domain when introduced.
- **Agenda** is reserved for a future combined Calendar-and-Tasks view; it is not
  a synonym for Calendar infrastructure.

The current product configures one Google Calendar. Provider-neutral domain APIs
keep model-facing tools stable and constrain the model's decision space; they do
not imply that multiple providers are currently aggregated.
