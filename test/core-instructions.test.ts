import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const coreInstructionsPath = fileURLToPath(
  new URL("../agent/instructions/core.ts", import.meta.url),
);

it("tells the model to exclude a leading Event action verb from an unquoted title", async () => {
  const instructions = await readFile(coreInstructionsPath, "utf8");

  expect(instructions).toContain(
    'For an unquoted Event request such as "Schedule dentist August 3 at 9am", use "Dentist" as the title.',
  );
  expect(instructions).toContain(
    "Preserve an action verb when the Owner explicitly quotes it or says it is part of the title.",
  );
});
