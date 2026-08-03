import { describe, expect, it, vi } from "vitest";

import { createOpenAITranscriptionAdapter } from "../agent/lib/transcription.js";

describe("OpenAI transcription adapter", () => {
  it("isolates the provider request behind the transcription interface", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ text: "  Buy milk  " }));
    const adapter = createOpenAITranscriptionAdapter({ apiKey: "secret", fetch: request });

    await expect(adapter.transcribe({
      bytes: new Uint8Array([1, 2, 3]), fileName: "voice.ogg",
      mediaType: "audio/ogg", model: "test-model",
    })).resolves.toBe("Buy milk");
    expect(request).toHaveBeenCalledWith("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: { authorization: "Bearer secret" }, body: expect.any(FormData),
    });
    const form = request.mock.calls[0]![1]!.body as FormData;
    expect(form.get("model")).toBe("test-model");
    expect((form.get("file") as File).type).toBe("audio/ogg");
  });

  it.each([
    [Response.json({ error: "nope" }, { status: 503 })],
    [Response.json({ text: "   " })],
  ])("rejects unusable provider responses", async (response) => {
    const adapter = createOpenAITranscriptionAdapter({
      apiKey: "secret", fetch: vi.fn(async () => response),
    });
    await expect(adapter.transcribe({
      bytes: new Uint8Array([1]), fileName: "voice.ogg",
      mediaType: "audio/ogg", model: "test-model",
    })).rejects.toThrow();
  });
});
