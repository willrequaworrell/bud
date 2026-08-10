import { mockModel } from "eve/evals";
import { expect, it, vi } from "vitest";

import { createPreparedWriteCorrectionClassifier } from "../agent/lib/prepared-write-correction.js";

it("classifies against only the pending Prepared Write and Owner text without tools", async () => {
  const responder = vi.fn(({ messages, tools, lastUserMessage }) => {
    expect(tools).toEqual([]);
    expect(messages).toEqual([
      expect.objectContaining({ role: "system", text: expect.stringContaining("corrects or revises") }),
      expect.objectContaining({
        role: "user",
        text: expect.stringContaining("Owner message:"),
      }),
    ]);
    return lastUserMessage?.includes("make that 1pm")
      ? '{"result":"correction"}'
      : '{"result":"unrelated"}';
  });
  const classify = createPreparedWriteCorrectionClassifier(mockModel(responder));

  await expect(classify({
    message: "Wait, make that 1pm",
    preparedWrite: { title: "Lunch", startLocal: "2026-08-07T12:00" },
    preparedWriteType: "event",
  })).resolves.toBe(true);
  await expect(classify({
    message: "What's on my calendar today?",
    preparedWrite: { title: "Lunch", startLocal: "2026-08-07T12:00" },
    preparedWriteType: "event",
  })).resolves.toBe(false);
  expect(responder).toHaveBeenCalledTimes(2);
});
