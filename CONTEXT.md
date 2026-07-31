# Bud

Bud is a private, reactive personal assistant for one Owner. Its language keeps
conversational intent separate from the Calendar and Tasks concepts that external
providers implement.

## Language

**Owner**:
The single person authorized to converse with Bud and access connected personal data.
_Avoid_: User, account

**Conversation**:
The Owner’s durable exchange with Bud, including context needed for follow-ups and clarification.
_Avoid_: Chat session, thread

**Calendar**:
The collection of Events Bud can read across its configured Calendar Sources.
_Avoid_: Personal Organizer

**Calendar Source**:
One connected provider calendar with a human-readable source name. A Calendar Source may belong to the Read Set, serve as the Write Calendar, or both.
_Avoid_: Container

**Read Set**:
The explicit set of Calendar Sources Bud combines when answering a general Calendar request.
_Avoid_: All calendars, calendar list

**Write Calendar**:
The single Calendar Source that defines Bud’s default Calendar timezone and receives future Event creation.
_Avoid_: Primary calendar, default calendar

**Event**:
A timed or all-day commitment belonging to one Calendar Source.
_Avoid_: Appointment, meeting

**Proposal**:
An immutable, fully rendered intention to perform exactly one external write. Approval applies only to its exact fields.
_Avoid_: Draft, confirmation

**Event Proposal**:
A Proposal for one non-recurring timed or all-day Event on the Write Calendar.
_Avoid_: Calendar draft

**Tasks**:
The domain of outstanding items the Owner intends to complete, separate from Calendar Events.
_Avoid_: To-dos calendar

**Agenda**:
A future combined view of Calendar Events and Tasks.
_Avoid_: Calendar
