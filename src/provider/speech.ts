import { basename } from "node:path";
import { readFile } from "node:fs/promises";

type FetchLike = typeof fetch;

export interface SpeechTranscriberConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  apiKey?: string;
  language?: string;
  prompt?: string;
}

export interface SpeechTranscriptionRequest {
  localPath: string;
  mimeType?: string;
  fileName?: string;
}

export interface SpeechTranscriptionResult {
  text: string;
}

export type SpeechTranscriber = (
  request: SpeechTranscriptionRequest
) => Promise<SpeechTranscriptionResult>;

function joinUrl(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${pathname}`;
}

export function createOpenAiCompatibleSpeechTranscriber(
  config: SpeechTranscriberConfig,
  fetchImpl: FetchLike = fetch
): SpeechTranscriber {
  return async (request) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    }, config.timeoutMs);

    try {
      const fileBuffer = await readFile(request.localPath);
      const form = new FormData();
      form.append(
        "file",
        new Blob([fileBuffer], { type: request.mimeType ?? "audio/mpeg" }),
        request.fileName ?? basename(request.localPath)
      );
      form.append("model", config.model);

      if (config.language) {
        form.append("language", config.language);
      }

      if (config.prompt) {
        form.append("prompt", config.prompt);
      }

      const response = await fetchImpl(joinUrl(config.baseUrl, "/audio/transcriptions"), {
        method: "POST",
        headers: {
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
        },
        body: form,
        signal: controller.signal
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          detail
            ? `Speech transcription failed (${response.status}): ${detail}`
            : `Speech transcription failed (${response.status})`
        );
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const payload = (await response.json()) as { text?: string };
        const text = payload.text?.trim();
        if (!text) {
          throw new Error("Speech transcription returned an empty result");
        }

        return { text };
      }

      const text = (await response.text()).trim();
      if (!text) {
        throw new Error("Speech transcription returned an empty result");
      }

      return { text };
    } finally {
      clearTimeout(timeout);
    }
  };
}
