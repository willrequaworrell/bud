import type { ToolContext } from "eve/tools";
import { expect, it, vi } from "vitest";

import {
  createCreateCalendarEventTool,
  createListCalendarEventsTool,
  createPrepareCalendarEventTool,
} from "../agent/lib/calendar-tool.js";

function context(principalId: string): ToolContext {
  return { callId: "call-123", session: { auth: { current: { principalId } } } } as ToolContext;
}

it("lets the authenticated Owner read sourced Calendar events", async () => {
  const listEvents = vi.fn(async () => [
    { kind: "timed" as const, title: "Standup", source: "Work",
      start: "2026-07-30T13:00:00Z", end: "2026-07-30T13:30:00Z" },
    { kind: "all-day" as const, title: "Birthday", source: "Personal",
      startDate: "2026-07-30", endDate: "2026-07-31" },
  ]);
  const tool = createListCalendarEventsTool({
    adapter: { async getDefaultTimeZone() { return "America/New_York"; }, listEvents },
    now: () => new Date("2026-07-29T15:00:00.000Z"), ownerId: "42",
  });

  const result = await tool.execute(
    { period: { kind: "tomorrow" } }, context("telegram:42"),
  );

  expect(result).toMatchObject({
    status: "ok",
    events: [
      { title: "Birthday", source: "Personal" },
      { title: "Standup", source: "Work" },
    ],
    resolvedPeriod: {
      startDate: "2026-07-30", endDate: "2026-07-30", timeZone: "America/New_York",
    },
  });
  expect(listEvents).toHaveBeenCalledOnce();
});

it("prepares without approval and creates only through per-call approval", async () => {
  const createEvent = vi.fn(async () => ({ eventId: "event-1" }));
  const adapter = {
    async getDefaultTimeZone() { return "America/New_York"; },
    async listEvents() { return []; }, createEvent,
  };
  const prepare = createPrepareCalendarEventTool({ adapter, ownerId: "42",
    now: () => new Date("2026-07-31T15:00:00Z") });
  const create = createCreateCalendarEventTool({ adapter, ownerId: "42" });
  const prepared = await prepare.execute({
    kind: "timed", title: "Dentist", startLocal: "2026-08-03T09:00",
  }, context("telegram:42"));
  if (prepared.status !== "ok") throw new Error("expected proposal");

  expect(prepare.approval).toBeUndefined();
  expect(await create.approval!({} as never)).toBe("user-approval");
  expect(await create.approval!({} as never)).toBe("user-approval");
  expect(createEvent).not.toHaveBeenCalled();
  expect(await create.execute({ proposal: prepared.proposal }, context("telegram:42")))
    .toEqual({ status: "ok", eventId: "event-1" });
  expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "call-123" }));
});

it("refuses Calendar Event creation when the executing caller is not the Owner", async () => {
  const createEvent = vi.fn(async () => ({ eventId: "event-1" }));
  const create = createCreateCalendarEventTool({
    adapter: { async getDefaultTimeZone() { return "UTC"; }, async listEvents() { return []; }, createEvent },
    ownerId: "42",
  });
  const proposal = {
    kind: "all-day" as const, proposalId: "0".repeat(64), title: "Private",
    startDate: "2026-08-07", throughDate: "2026-08-07", timeZone: "UTC",
    location: null, description: null, warning: null,
  };

  expect(await create.execute({ proposal }, context("telegram:99")))
    .toEqual({ status: "error", reason: "forbidden" });
  expect(createEvent).not.toHaveBeenCalled();
});

it("re-enforces Owner authorization inside the Calendar tool", async () => {
  const listEvents = vi.fn(async () => []);
  const tool = createListCalendarEventsTool({
    adapter: { async getDefaultTimeZone() { return "UTC"; }, listEvents }, ownerId: "42",
  });

  expect(await tool.execute(
    { period: { kind: "today" } }, context("telegram:99"),
  )).toEqual({ status: "error", reason: "forbidden" });
  expect(listEvents).not.toHaveBeenCalled();
});
