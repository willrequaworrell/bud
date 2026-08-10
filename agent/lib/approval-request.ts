export interface ApprovalRequest {
  input: unknown;
  toolName: string;
}

export interface ExactApprovalRequest {
  preparedWrite: Record<string, unknown>;
  preparedWriteType: "event" | "task";
  prompt: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function renderPreparedEvent(preparedEvent: Record<string, unknown>): string | undefined {
  if (typeof preparedEvent.title !== "string" ||
      typeof preparedEvent.kind !== "string" || typeof preparedEvent.timeZone !== "string") {
    return undefined;
  }

  let when: string;
  if (preparedEvent.kind === "timed" && typeof preparedEvent.startLocal === "string" &&
      typeof preparedEvent.endLocal === "string") {
    when = `${preparedEvent.startLocal}–${preparedEvent.endLocal} (${preparedEvent.timeZone})`;
  } else if (preparedEvent.kind === "all-day" && typeof preparedEvent.startDate === "string" &&
      typeof preparedEvent.throughDate === "string") {
    when = preparedEvent.startDate === preparedEvent.throughDate
      ? `${preparedEvent.startDate} (all day; ${preparedEvent.timeZone})`
      : `${preparedEvent.startDate}–${preparedEvent.throughDate} (all day; ${preparedEvent.timeZone})`;
  } else {
    return undefined;
  }

  const details = [preparedEvent.title, `When: ${when}`];
  const recurrence = record(preparedEvent.recurrence);
  const recurrenceEnd = record(recurrence?.end);
  if (recurrence && recurrenceEnd && typeof recurrence.frequency === "string" &&
      typeof recurrence.interval === "number") {
    const weekdays = Array.isArray(recurrence.weekdays)
      ? recurrence.weekdays.filter((day): day is string => typeof day === "string") : [];
    const weekdayNames: Record<string, string> = {
      MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday",
      FR: "Friday", SA: "Saturday", SU: "Sunday",
    };
    const cadence = recurrence.interval === 1
      ? `Every ${{ daily: "day", weekly: "week", monthly: "month" }[recurrence.frequency] ?? recurrence.frequency}`
      : `Every ${recurrence.interval} ${recurrence.frequency === "daily" ? "days" :
          recurrence.frequency === "weekly" ? "weeks" : "months"}`;
    const onDays = weekdays.length
      ? ` on ${weekdays.map((day) => weekdayNames[day] ?? day).join(weekdays.length === 2 ? " and " : ", ")}`
      : "";
    const boundary = recurrenceEnd.kind === "count" && typeof recurrenceEnd.count === "number"
      ? `${recurrenceEnd.count} occurrences`
      : recurrenceEnd.kind === "until" && typeof recurrenceEnd.date === "string"
        ? `through ${recurrenceEnd.date}` : undefined;
    if (boundary) details.push(`Repeats: ${cadence}${onDays}; ${boundary}`);
  }
  if (typeof preparedEvent.location === "string") {
    details.push(`Location: ${preparedEvent.location}`);
  }
  if (typeof preparedEvent.description === "string") {
    details.push(`Description: ${preparedEvent.description}`);
  }
  const warnings = Array.isArray(preparedEvent.warnings)
    ? preparedEvent.warnings.flatMap((warning) => {
        const message = record(warning)?.message;
        return typeof message === "string" ? [`Warning: ${message}`] : [];
      })
    : [];
  return ["Create Calendar Event?", "", ...details, ...(warnings.length ? ["", ...warnings] : [])]
    .join("\n");
}

function renderPreparedTask(preparedTask: Record<string, unknown>): string | undefined {
  if (typeof preparedTask.title !== "string" ||
      !(preparedTask.dueDate === null || typeof preparedTask.dueDate === "string") ||
      !(preparedTask.notes === null || typeof preparedTask.notes === "string")) return undefined;
  return [
    "Create Task?", "", preparedTask.title,
    `Due: ${preparedTask.dueDate ?? "No due date"}`,
    ...(preparedTask.notes ? [`Notes: ${preparedTask.notes}`] : []),
  ].join("\n");
}

export function parseApprovalRequest(request: ApprovalRequest): ExactApprovalRequest | undefined {
  const input = record(request.input);
  if (request.toolName.endsWith("create_calendar_event")) {
    const preparedWrite = record(input?.preparedEvent);
    const prompt = preparedWrite ? renderPreparedEvent(preparedWrite) : undefined;
    return preparedWrite && prompt
      ? { preparedWrite, preparedWriteType: "event", prompt }
      : undefined;
  }
  if (request.toolName.endsWith("create_task")) {
    const preparedWrite = record(input?.preparedTask);
    const prompt = preparedWrite ? renderPreparedTask(preparedWrite) : undefined;
    return preparedWrite && prompt
      ? { preparedWrite, preparedWriteType: "task", prompt }
      : undefined;
  }
  return undefined;
}

export function renderApprovalRequest(request: ApprovalRequest): string | undefined {
  return parseApprovalRequest(request)?.prompt;
}
