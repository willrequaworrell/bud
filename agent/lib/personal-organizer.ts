export interface Event {
  end: string;
  start: string;
  title: string;
}

export interface EventRange {
  end: string;
  start: string;
  timeZone: string;
}

export type PersonalOrganizerFailure =
  | "access-revoked"
  | "authentication-expired"
  | "rate-limited"
  | "unavailable";

export class PersonalOrganizerError extends Error {
  constructor(readonly reason: PersonalOrganizerFailure) {
    super(reason);
    this.name = "PersonalOrganizerError";
  }
}

export interface PersonalOrganizer {
  getDefaultTimeZone(): Promise<string>;
  listEvents(range: EventRange): Promise<readonly Event[]>;
}
