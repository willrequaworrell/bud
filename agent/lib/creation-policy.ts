import type { Approval, ApprovalContext } from "eve/tools/approval";

import type { CreationGuard } from "./creation-guard.js";

export function createCreationApprovalPolicy(options: {
  readonly guard: CreationGuard;
  readonly ownerId: string;
}): Approval {
  return async (context: ApprovalContext) => {
    if (context.session.auth.current?.principalId !== `telegram:${options.ownerId}`) {
      return { type: "denied", reason: "forbidden" };
    }
    const decision = await options.guard.reserve({
      callId: context.callId,
      ownerId: options.ownerId,
      sessionId: context.session.id,
      turnId: context.session.turn.id,
    });
    if (decision === "automatic") return "not-applicable";
    if (decision === "approval-request") return "user-approval";
    return decision;
  };
}
