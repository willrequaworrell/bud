export interface TranscriptionInput {
  bytes: Uint8Array;
  fileName: string;
  mediaType: string;
  model: string;
}

export interface TranscriptionAdapter {
  transcribe(input: TranscriptionInput): Promise<string>;
}

export interface OpenAITranscriptionOptions {
  apiKey?: string;
  fetch?: typeof fetch;
}

export function createOpenAITranscriptionAdapter(
  options: OpenAITranscriptionOptions = {},
): TranscriptionAdapter {
  const request = options.fetch ?? fetch;
  return {
    async transcribe(input) {
      const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("Transcription provider is not configured");
      const form = new FormData();
      const bytes = new Uint8Array(input.bytes.byteLength);
      bytes.set(input.bytes);
      form.set("file", new Blob([bytes], { type: input.mediaType }), input.fileName);
      form.set("model", input.model);
      const response = await request("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: form,
      });
      if (!response.ok) throw new Error(`Transcription failed with HTTP ${response.status}`);
      const payload = await response.json() as { text?: unknown };
      if (typeof payload.text !== "string" || !payload.text.trim()) {
        throw new Error("Transcription response did not include text");
      }
      return payload.text.trim();
    },
  };
}
