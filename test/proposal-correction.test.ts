import { mockModel } from "eve/evals";
import { expect, it, vi } from "vitest";

import { createProposalCorrectionClassifier } from "../agent/lib/proposal-correction.js";

it("classifies against only the pending Proposal and Owner text without tools", async () => {
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
  const classify = createProposalCorrectionClassifier(mockModel(responder));

  await expect(classify({
    message: "Wait, make that 1pm",
    proposal: { title: "Lunch", startLocal: "2026-08-07T12:00" },
    proposalType: "event",
  })).resolves.toBe(true);
  await expect(classify({
    message: "What's on my calendar today?",
    proposal: { title: "Lunch", startLocal: "2026-08-07T12:00" },
    proposalType: "event",
  })).resolves.toBe(false);
  expect(responder).toHaveBeenCalledTimes(2);
});
