# Siri and Shortcuts as a low-friction bridge into Bud

Date: 2026-08-07

## Question

What is the smallest secure bridge that lets the Owner speak to Bud in passing, while preserving Bud's existing Owner authentication and Approval Request boundaries?

## Conclusion

Try the **Telegram Siri-contact path first**, because it may already provide the desired experience with no Bud code: create an iOS contact that resolves to the Bud bot, then say “Siri, message Bud on Telegram.” If the current Telegram iOS app accepts the contact convention on the Owner's actual phone, Telegram sends a genuine message from the Owner's Telegram account. That means Bud's existing webhook authentication, private-chat check, `from.id` Owner check, Conversation state, and Telegram approval buttons all continue to work unchanged.

This contact convention is an undocumented Telegram-iOS behavior discovered through a [user-supplied lead](https://www.hongkiat.com/blog/use-siri-message-telegram-bot/), not a public Telegram API contract. Apple does officially define Siri messaging intents that let a messaging app send a message to designated recipients, and those intents do not inherently require an unlocked device ([Apple `INSendMessageIntent`](https://developer.apple.com/documentation/Intents/INSendMessageIntent)). Apple also says compatible third-party messaging apps can be controlled with Siri in CarPlay ([Apple CarPlay guide](https://support.apple.com/en-ie/guide/iphone/iph206c570e3/ios)). The exact Telegram bot-contact resolution must therefore be treated as a device prototype, not an architectural dependency.

If that path is unreliable or too Telegram-specific, build a personal Shortcut named **Tell Bud** that collects one utterance and `POST`s it to a narrow Bud capture endpoint. A native iOS app and App Intent are not necessary for this MVP. The server should acknowledge capture quickly, process the request using Bud's existing agent and domain tools, and route any clarification or Approval Request back to Telegram.

## Why this fits the current Bud architecture

Bud currently has three relevant boundaries:

1. Telegram accepts only private text from the configured Owner. `isOwnerPrivateText`/`ownerPrivateRawMessage` require a private chat and matching Telegram `from.id`.
2. The authenticated Eve principal is built as `telegram:<Owner ID>` with Telegram webhook provenance.
3. Calendar and Task writes remain behind immutable Prepared Writes, Owner reauthorization, and native Eve approval. A changed Prepared Write needs a fresh Approval Request.

The direct Telegram Siri path naturally crosses boundary 1 as a real Owner message. It is therefore the lowest-risk path.

A direct HTTP endpoint is a new authenticated ingress. It must not call Google Calendar or Tasks directly, and it must not treat possession of a capture token as approval for an external write. It should enter the same conversational/tool path as Telegram and preserve the Prepared Write boundaries. Today, Calendar and Task tools authorize the exact principal ID `telegram:<Owner ID>`, so a new channel either needs to mint that same canonical Owner principal after verifying its own credential, or the codebase should first separate the domain concept `Owner` from the Telegram-specific principal spelling. That is an architectural decision, not something the Shortcut should work around.

## Option comparison

| Option | Owner experience | Bud changes | Security/architecture | Recommendation |
|---|---|---:|---|---|
| Siri → Telegram contact → Bud | “Message Bud on Telegram,” dictate, optionally confirm | None if the Telegram-iOS contact behavior works | Genuine Telegram Owner message; existing webhook and approval flow stay intact | **Prototype first** |
| Personal Shortcut → Bud HTTPS capture endpoint | “Tell Bud,” answer prompt, hear receipt | New ingress and cross-channel delivery | Needs a separate capture credential, replay handling, Owner mapping, and strict preservation of Approval Requests | **MVP fallback / phase 1** |
| Personal Shortcut → synchronous agent webhook → Speak Text | Custom spoken phrase, dictate, wait, hear full agent answer | Same new ingress, plus synchronous agent execution | Simple demo path, but long-running tools, authentication, replay, failures, and approval UX all remain | **Useful prototype variant, not Bud's default** |
| Shortcut → Telegram Bot API | Custom voice Shortcut posts to `sendMessage` | Superficially small | Wrong direction: `sendMessage` sends *as the bot*, not as the Owner, so it is not an inbound Owner update; putting the bot token on the phone grants full bot control | **Do not use** |
| Telegram deep link | Opens Telegram or starts a bot interaction | Little or none | Public bot links carry a bounded start parameter and present a Start action; draft/share links open UI rather than silently delivering an arbitrary Owner message | **Not the hands-free bridge** |
| Native Bud app + App Intent/App Shortcut | Polished “Tell Bud …” action available on install, richer Siri integration | iOS app, signing/distribution, intent code | Better credential storage, structured parameters, explicit lock policy, testing surface | **Later, after proven use** |

### Why the Bot API is not the bridge

The Bot API's `sendMessage` method sends a message from the bot to a target chat; it does not impersonate the Telegram user and produce the Owner-originated inbound message Bud authorizes ([Telegram Bot API](https://core.telegram.org/bots/api#sendmessage)). Telegram also warns that anyone with a bot token has full control of the bot, so the token must be stored securely ([Telegram bot introduction](https://core.telegram.org/bots#how-do-i-create-a-bot)). The Shortcut must never contain `TELEGRAM_BOT_TOKEN` or `TELEGRAM_WEBHOOK_SECRET_TOKEN`.

Telegram's documented bot deep link is `t.me/<bot_username>?start=<parameter>`; the parameter is limited to 64 base64url characters and the client presents a Start button that invokes the bot when pressed ([Telegram deep links](https://core.telegram.org/api/links#bot-links)). This is useful for opening a bot into a known flow, but it is not arbitrary, frictionless dictation. Telegram's documented message-draft links open a share screen and put text into a composer rather than automatically sending it ([Telegram TDLib message-draft link](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1internal_link_type_message_draft.html)).

## Phase 0: test Siri's Telegram messaging path

The user-supplied lead proposes:

1. Extract the numeric bot ID (the digits before `:` in the bot token).
2. Create an iOS Contact named **Bud**.
3. Add a URL with the contact label **Telegram** and value `https://t.me/@oid<BOT_ID>`.
4. Ensure the Owner has already started a private chat with Bud.
5. Say, “Siri, message Bud on Telegram,” then dictate the request.

This is *not* a Shortcut and does not call the Bot API. It asks Siri to use Telegram as a messaging service. Apple's messaging contract supplies the intended platform mechanism: Siri creates an `INSendMessageIntent` containing the content and recipient, and the messaging app handles and confirms it ([Apple `INSendMessageIntent`](https://developer.apple.com/documentation/Intents/INSendMessageIntent)). Telegram's public deep-link documentation does not document the `@oid` contact form; its public bot forms use usernames or `tg://resolve` parameters ([Telegram deep links](https://core.telegram.org/api/links#bot-links)). Consequently, support for `@oid`, bot-recipient resolution, locked-phone behavior, and CarPlay behavior must all be verified on the Owner's current iPhone and Telegram build.

If it works, this path is unusually good for Bud:

- No additional credential is created or copied to the phone.
- Telegram establishes the sender identity Bud already trusts.
- The request enters the existing Conversation rather than creating a parallel inbox.
- Clarifying replies and Approval Request buttons appear in the same chat.
- It tests the real behavioral hypothesis—whether hands-free capture changes usage—before any implementation work.

Its weaknesses are dependence on an undocumented Telegram-iOS convention, a less natural invocation phrase, Siri/Telegram confirmation behavior, and limited control over the acknowledgement. A Telegram update could break it.

## Phase 1: personal “Tell Bud” Shortcut

Apple says Siri can run any Shortcut in the user's collection by name from iPhone/iPad, HomePod, Apple Watch, or Mac, and Siri tells the user the result when it finishes ([Apple Shortcuts Siri guide](https://support.apple.com/en-ca/guide/shortcuts/apd07c25bb38/ios)). A first Shortcut can therefore be built without an iOS app.

### Concrete interaction

Target happy path:

> Owner: “Siri, Tell Bud.”  
> Siri: “What should I tell Bud?”  
> Owner: “Remind me to order furnace filters this weekend.”  
> Siri: “Got it. I sent that to Bud.”

Recommended actions:

1. **Ask for Input** with type Text and prompt “What should I tell Bud?” Apple documents that the answer becomes the next action's input/Magic Variable ([Apple Ask for Input](https://support.apple.com/guide/shortcuts/use-the-ask-for-input-action-apd68b5c9161/ios)). Prototype **Dictate Text** as an alternative, but do not assume it is more hands-free: actions that use the microphone can have extra execution limitations, including opening Shortcuts in some contexts ([Apple action limitations](https://support.apple.com/en-ie/guide/shortcuts/-apd081d9d61f/ios)).
2. Build a Dictionary containing `message`, `clientRequestId`, `capturedAt`, `source: "siri-shortcut"`, and optionally the device timezone.
3. **Get Contents of URL** to `POST` JSON to `https://<bud-host>/capture`. Apple documents that this action supports GET, POST, PUT, PATCH, and DELETE; POST/PUT/PATCH can send JSON, Form, or File request bodies ([Apple API request guide](https://support.apple.com/en-au/guide/shortcuts/apd58d46713f/ios)).
4. Read a small JSON response such as `{ "status": "accepted", "acknowledgement": "Got it. I sent that to Bud." }`.
5. Use **Stop and Output → Respond** so Siri has an explicit completion response ([Apple Stop and Output](https://support.apple.com/en-ca/guide/shortcuts/apda9578f70f/ios)). Optionally also use **Show Notification** for a persistent visual receipt; it posts immediately and lets the Shortcut continue ([Apple Show Notification](https://support.apple.com/guide/shortcuts/use-the-show-notification-action-apd2175adcab/ios)).

The endpoint should return the receipt quickly. It should not hold the Siri invocation open while a model reasons, calls Google, asks a clarification, or waits for approval. Bud can send the substantive answer or Approval Request to Telegram afterward.

### What the Justin Melendez video demonstrates

The secondary-source video [“How I connected Siri to my AI Agent in less than 10 minutes!”](https://www.youtube.com/watch?v=3zgYkZFDp_w) shows a concrete variant of this phase-1 design:

1. An n8n workflow begins with an HTTP webhook, passes the received text to an AI agent with GoHighLevel CRM tools, and ends with n8n's webhook-response node.
2. The iPhone Shortcut uses **Dictate Text**, configured for English and **Stop on Tap**.
3. **Get Contents of URL** sends a `POST` to the n8n test webhook with a request-body field named `dictated text`, populated from the Dictate Text output.
4. **Speak Text** receives the Get Contents of URL output and uses a Siri voice to read the agent's synchronous webhook response.
5. The Shortcut is added to the Home Screen. The video then configures **Settings → Accessibility → Voice Control → Customize Commands → Create New Command**, with a custom phrase that runs the Shortcut.

Apple independently documents the important platform capabilities: Get Contents of URL supports POST and structured request bodies ([Apple API request guide](https://support.apple.com/en-au/guide/shortcuts/apd58d46713f/ios)); custom Voice Control commands can choose **Run Shortcut** as their action ([Apple Voice Control command guide](https://support.apple.com/en-us/118275)); and Voice Control can remain listening for spoken commands after its one-time setup ([Apple Voice Control guide](https://support.apple.com/en-us/111778)). The video's last invocation is therefore a Voice Control custom command, not evidence that the workflow requires Siri or a native App Intent.

This is useful practical evidence that the proposed Shortcut shape is small: voice-to-text → HTTP POST → spoken HTTP result. It does **not** add a distinct server architecture. It is the synchronous version of Bud's phase-1 direct endpoint.

Bud should not copy several demo choices unchanged:

- **Stop on Tap** undermines the desired hands-free interaction. Test stop-after-pause first, with Ask for Input as the alternative.
- The video shows a test webhook URL and no request authentication, replay protection, or Owner binding. Bud's endpoint needs the controls in the security section below.
- The demo lets the remote agent act on CRM tools before returning. Bud must retain its immutable Prepared Write and explicit Approval Request boundaries for Calendar and Task writes.
- A synchronous full-agent response is attractive for read-only, fast questions, but model/tool latency and clarification or approval make it a poor universal transport contract. Bud's default should acknowledge quickly and continue through Telegram; a later bounded “quick answer” mode could speak a synchronous response under a strict timeout.
- Voice Control is an iPhone accessibility subsystem, not the same cross-device invocation as asking Siri to run a Shortcut. Apple notes that when Voice Control is on, standard iOS Dictation is unavailable ([Apple Voice Control commands guide](https://support.apple.com/en-lamr/guide/iphone/-iph2c21a3c88/ios)); the interaction between Voice Control and the Shortcut's Dictate Text action therefore needs device testing.

There is also a separate **Vocal Shortcuts** feature that can run an action after an on-device recognized phrase, while continuously using the microphone when enabled ([Apple Vocal Shortcuts guide](https://support.apple.com/guide/iphone/use-vocal-shortcuts-iph7f242ea2c/ios)). It may provide the video's custom-wake-phrase experience more directly on current iOS, but it is iPhone-local and should be compared with ordinary “Siri, Tell Bud” invocation for privacy, accidental triggers, battery, lock-screen behavior, and reliability.

### Suggested request and response

```http
POST /capture HTTP/1.1
Authorization: Bearer <revocable-capture-only-token>
Content-Type: application/json

{
  "message": "Remind me to order furnace filters this weekend",
  "clientRequestId": "<client-generated-random-id>",
  "capturedAt": "2026-08-07T14:32:10-04:00",
  "source": "siri-shortcut",
  "timeZone": "America/New_York"
}
```

```json
{
  "status": "accepted",
  "acknowledgement": "Got it. I sent that to Bud."
}
```

The exact availability and editor location of custom request headers, a UUID generator, and date formatting should be verified on the target iOS version. Apple's cited guide explicitly documents request methods and bodies but not every current editor control.

## Authentication, replay, and owner binding

For a personal prototype:

- Generate a high-entropy, **capture-only**, independently revocable token. It authorizes submission of bounded text; it must not authorize Calendar/Task writes, reads, approvals, or administrative operations.
- Send it in `Authorization: Bearer ...`, never in the URL. The bearer-token standard recommends the Authorization header, requires TLS, and warns that URLs containing tokens are commonly logged ([RFC 6750 sections 2.1 and 2.3](https://www.rfc-editor.org/rfc/rfc6750.html#section-2.1)).
- Treat possession as sufficient to submit captures. Bearer tokens do not prove possession of a cryptographic key and must be protected in storage and transport ([RFC 6750](https://www.rfc-editor.org/rfc/rfc6750.html#section-1.2)). A personal Shortcut's embedded token is visible to someone who can edit or export that Shortcut, so this is not an appropriate distributed-user authentication scheme.
- Validate `Content-Type`, schema, message length, timestamps, and accepted source values. Apply a small request-body limit and per-token rate limit.
- Require `clientRequestId` and store a bounded deduplication record. Return the same receipt for retries with the same ID. This protects against accidental double execution when Siri or the network retries.
- Log request IDs and outcomes, never tokens or full Authorization headers. Avoid logging private utterances unless deliberately needed for the product.
- Map the capture token server-side to the one configured Owner. Do not accept `ownerId` from the body.
- Keep Approval Requests separate. A valid capture token proves who may speak to Bud; it is not an approval click and cannot bypass Prepared Event/Task identity checks.

For a later distributable system, prefer per-device enrollment, short-lived credentials, revocation UI, and app-managed secure storage. HTTP Message Signatures are a standardized proof-of-possession option if replay-resistant signed requests become necessary, but they would add complexity beyond a personal Shortcut MVP ([RFC 9421](https://www.rfc-editor.org/rfc/rfc9421.html)).

## Locked device, background, and device reach

Apple explicitly says Siri asks for an unlock when a Shortcut opens an app while the device is locked ([Apple Shortcuts Siri guide](https://support.apple.com/en-ca/guide/shortcuts/apd07c25bb38/ios)). That supports keeping the flow to input → HTTPS → response, with no `Open App` action. Apple does **not** promise in the cited material that every interactive prompt and network action will always complete on a locked iPhone, HomePod, Watch, AirPods, or CarPlay. Fully locked, screen-free operation is a prototype gate.

Personal automations are complementary, not the capture transport. Apple supports triggers such as time, alarm, arrival/leave, CarPlay, app, communication, NFC, Focus, and battery, and many automations can run without asking, though individual actions can still require permission ([Apple personal automation settings](https://support.apple.com/guide/shortcuts/enable-or-disable-a-personal-automation-apd602971e63/ios)). Personal automations are device-specific and do not sync across devices ([Apple personal automation guide](https://support.apple.com/en-gb/guide/shortcuts/apd690170742/9.0/ios/26)). Bud's durable scheduling and proactive behavior should remain server-side.

Apple says Siri can launch Shortcuts from HomePod and Apple Watch, but action support differs by device ([Apple Shortcuts Siri guide](https://support.apple.com/en-ca/guide/shortcuts/apd07c25bb38/ios)). HomePod Personal Requests rely on a paired iPhone/iPad and configuration such as Recognize My Voice and Personal Requests ([Apple HomePod guide](https://support.apple.com/guide/homepod/make-personal-content-requests-apde0a4edb55/homepod)). Do not promise whole-house capture until the exact Shortcut succeeds from the Owner's HomePod.

## When a native app and App Intent become worthwhile

They are not necessary to learn whether the core habit works. A personal Shortcut already runs by name through Siri and can call an HTTPS API.

Build a native Bud app only when one or more of these become important:

- installing and configuring the action without manually editing a Shortcut;
- app-managed credential storage and device enrollment;
- structured parameters and richer error/result presentation;
- explicit authentication policy for locked-device execution;
- broader distribution to other people;
- deeper Siri/Spotlight/Action Button integration.

Apple's App Intents framework exposes app actions directly to Siri and Shortcuts and lets intent results provide text or visual content ([Apple App Intents](https://developer.apple.com/documentation/AppIntents/app-intents)). App Shortcuts make preconfigured actions available on installation without manual Shortcut setup ([Apple App Shortcuts](https://developer.apple.com/documentation/appintents/app-shortcuts)). Native App Intents can explicitly choose whether an action is allowed while locked, requires authentication, or requires the local device to unlock ([Apple `IntentAuthenticationPolicy`](https://developer.apple.com/documentation/AppIntents/IntentAuthenticationPolicy)).

## Recommended phases

### Phase 0 — one-evening behavioral prototype

1. Configure the Telegram bot contact from the supplied lead.
2. Test iPhone unlocked and locked, then AirPods and CarPlay if relevant.
3. Use it for one week and note whether requests actually increase.
4. Record friction: invocation phrase, confirmation, recipient resolution, response visibility, and Approval Request handoff.

### Phase 1 — capture-only Shortcut and endpoint

1. Build **Tell Bud** with Ask for Input, HTTPS POST, and Respond.
2. Add one capture-only token, body limits, rate limiting, and idempotent request IDs.
3. Return a receipt immediately.
4. Deliver Bud's substantive response and all approvals through Telegram.
5. Preserve the existing immutable Prepared Write boundary; do not add direct Calendar/Tasks mutation to `/capture`.

### Phase 2 — tighter conversational integration

1. Give Siri captures continuity with the Owner's active Bud Conversation.
2. Define behavior when that Conversation already has a pending Approval Request. The current Telegram rule refuses unrelated work until approval/denial/reset; Siri ingress should not create a bypass.
3. Add delivery receipts and failure notifications.
4. Decide whether a dedicated Capture/Inbox domain concept is useful, rather than forcing every utterance into immediate agent execution.

### Phase 3 — native app only if justified

Add an App Intent/App Shortcut, per-device enrollment, secure credential storage, and explicit lock policy after the daily habit and desired interaction are proven.

## Device prototype test plan

Run every test against a non-production or clearly reversible Bud setup where practical.

| Area | Test | Success criterion |
|---|---|---|
| Telegram contact | “Siri, message Bud on Telegram” while unlocked | Correct bot resolves; genuine Owner text reaches existing Conversation |
| Telegram contact | Same while phone is locked | No touch/unlock if that is a product requirement; otherwise document exact friction |
| Telegram contact | Task/Event request | Existing Approval Request appears in Telegram; no write occurs before approval |
| Telegram contact | CarPlay / AirPods | Recipient and dictated content are correct; confirmation behavior is acceptable |
| Shortcut input | Ask for Input unlocked and locked | Siri accepts a spoken answer without opening UI or requiring touch |
| Shortcut alternative | Dictate Text unlocked and locked | Compare reliability and whether Shortcuts opens |
| HTTP | Wi-Fi and cellular | One capture, quick acknowledgement, correct Telegram follow-up |
| HTTP failures | Offline, timeout, 401, 429, 500, malformed JSON | Short, truthful Siri response; no false success |
| Replay | Submit the same `clientRequestId` twice | One logical capture and stable receipt |
| Pending Approval Request | Submit unrelated Siri capture while approval is pending | Existing one-pending-Approval-Request policy is preserved |
| Phrase | “Tell Bud,” “Capture for Bud,” noisy room, namesake contact | No collision with contacts or built-in Siri commands |
| Invocation mode | Siri name vs Voice Control command vs Vocal Shortcut | Record microphone/listening requirements, accidental triggers, lock behavior, and whether Dictate Text still works |
| Other devices | Apple Watch and HomePod | Record where execution occurs and whether prompts/responses remain hands-free |
| Privacy | Export/share the Shortcut | Confirm the embedded token exposure and revocation procedure |

## Open uncertainties that documentation cannot settle

1. Does the current Telegram iOS release still resolve `https://t.me/@oid<BOT_ID>` when stored as a Telegram-labeled Contact URL?
2. Does Siri send to that bot from a locked iPhone without requiring a confirmation or unlock?
3. Does Telegram's messaging intent work the same through AirPods and CarPlay, and can replies be announced?
4. Does Ask for Input become a natural spoken follow-up when the Shortcut was itself launched through Siri, or does the current iOS build show a dialog?
5. Does Get Contents of URL run while locked on the Owner's exact iOS version and network/privacy settings?
6. Which action is more reliable for this use case: Ask for Input or Dictate Text?
7. How should a non-Telegram ingress attach to Eve's existing Telegram-backed Conversation and send output back to Telegram without synthesizing a fake Telegram webhook?
8. Should Siri submissions be immediate agent turns, or durable Capture/Inbox items acknowledged first and interpreted asynchronously?
9. How should the canonical Owner principal be named if Bud gains more authenticated channels, given that tools currently authorize `telegram:<Owner ID>`?
10. Is a synchronous spoken “quick answer” valuable enough to support separately from the default accepted-and-follow-up flow, and what timeout/tool restrictions would make it reliable?
11. On the Owner's current iOS version, which custom-phrase mechanism behaves best: ordinary Siri invocation, Voice Control custom command, or Vocal Shortcuts?

## Decision recommendation

The fastest honest experiment is the Telegram Siri-contact path. It directly tests the desired “say it in passing” behavior and, if successful, already honors Bud's security model better than a new endpoint.

Do not build a Shortcut that contains the Telegram bot token. If the Telegram-contact experiment fails or proves brittle, implement the narrow personal Shortcut endpoint next. Keep it capture-only at the transport boundary, authenticate it with a revocable low-scope token, respond immediately, and send all complex conversation and Approval Requests back through Telegram. Native App Intents should remain a later productization step.
