import type { ApprovalContext } from "eve/tools/approval";
import { expect, it } from "vitest";

import { createFakeCreationGuard } from "../agent/lib/creation-guard.js";
import { createCreationApprovalPolicy } from "../agent/lib/creation-policy.js";

function context(principalId: string): ApprovalContext {
  return {
    approvedTools: new Set(), callId: "call-1", toolName: "create_task",
    session: {
      id: "session-1", auth: { current: { principalId }, initiator: null },
      turn: { id: "turn-1", sequence: 0 },
    },
  } as unknown as ApprovalContext;
}

it("consults the injected guard through Eve's public approval seam", async () => {
  const guard = createFakeCreationGuard(["automatic"]);
  const policy = createCreationApprovalPolicy({ guard, ownerId: "42" });

  await expect(policy(context("telegram:42"))).resolves.toBe("not-applicable");
  expect(guard.requests).toEqual([{
    callId: "call-1", ownerId: "42", sessionId: "session-1", turnId: "turn-1",
  }]);
});

it("denies an unauthorized caller before it touches guard state", async () => {
  const guard = createFakeCreationGuard();
  const policy = createCreationApprovalPolicy({ guard, ownerId: "42" });

  await expect(policy(context("telegram:99"))).resolves.toEqual({
    type: "denied", reason: "forbidden",
  });
  expect(guard.requests).toEqual([]);
});
