import { generateText, Output, type LanguageModel } from "ai";

export interface PreparedWriteCorrectionClassifier {
  (input: {
    message: string;
    preparedWrite: Record<string, unknown>;
    preparedWriteType: "event" | "task";
  }): Promise<boolean>;
}

export function createPreparedWriteCorrectionClassifier(
  model: LanguageModel,
): PreparedWriteCorrectionClassifier {
  return async ({ message, preparedWrite, preparedWriteType }) => {
    const result = await generateText({
      model,
      output: Output.choice({ options: ["correction", "unrelated"] }),
      prompt: [
        `Pending Prepared ${preparedWriteType === "task" ? "Task" : "Event"}:`,
        JSON.stringify(preparedWrite),
        "",
        `Owner message: ${JSON.stringify(message)}`,
      ].join("\n"),
      system: [
        "Classify whether the Owner message corrects or revises the pending Prepared Write.",
        "Choose correction only when the message changes, removes, adds, or clarifies a Prepared Write field.",
        "Questions, unrelated requests, approval, denial, and ambiguous remarks are unrelated.",
        "You have no tools. Return only the requested choice.",
      ].join(" "),
    });
    return result.output === "correction";
  };
}
