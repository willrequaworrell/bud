import { defineDynamic, defineInstructions } from "eve/instructions";

import { getConfiguredCalendarTimeZone } from "../lib/configured-calendar.js";

export default defineDynamic({
  events: {
    "turn.started": async () => {
      try {
        const timeZone = await getConfiguredCalendarTimeZone();
        const now = new Date();
        const local = new Intl.DateTimeFormat("en-CA", {
          dateStyle: "full",
          timeStyle: "long",
          timeZone,
        }).format(now);
        return defineInstructions({
          markdown: `Calendar temporal context for this turn: ${local}; IANA timezone: ${timeZone}; current instant: ${now.toISOString()}.`,
        });
      } catch {
        return defineInstructions({
          markdown: `Calendar temporal context is unavailable. Ask for an exact date if resolving a relative Calendar date would require guessing.`,
        });
      }
    },
  },
});
