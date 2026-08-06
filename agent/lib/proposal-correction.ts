import { generateText, Output, type LanguageModel } from "ai";

export interface ProposalCorrectionClassifier {
  (input: {
    message: string;
    proposal: Record<string, unknown>;
    proposalType: "event" | "task";
  }): Promise<boolean>;
}

export function createProposalCorrectionClassifier(model: LanguageModel): ProposalCorrectionClassifier {
  return async ({ message, proposal, proposalType }) => {
    const result = await generateText({
      model,
      output: Output.choice({ options: ["correction", "unrelated"] }),
      prompt: [
        `Pending ${proposalType} Proposal:`,
        JSON.stringify(proposal),
        "",
        `Owner message: ${JSON.stringify(message)}`,
      ].join("\n"),
      system: [
        "Classify whether the Owner message corrects or revises the pending Proposal.",
        "Choose correction only when the message changes, removes, adds, or clarifies a Proposal field.",
        "Questions, unrelated requests, approval, denial, and ambiguous remarks are unrelated.",
        "You have no tools. Return only the requested choice.",
      ].join(" "),
    });
    return result.output === "correction";
  };
}
