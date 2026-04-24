import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenAiCompatibleSpeechTranscriber } from "../src/provider/speech";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("speech provider", () => {
  it("posts audio files to the OpenAI-compatible transcription endpoint", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codeclaw-speech-"));
    tempDirs.push(dir);
    const audioPath = path.join(dir, "voice.mp3");
    await writeFile(audioPath, Buffer.from("hello-audio"));

    let requestUrl = "";
    let requestBody: RequestInit["body"] | null | undefined;
    const transcribe = createOpenAiCompatibleSpeechTranscriber(
      {
        baseUrl: "https://example.test/v1",
        model: "whisper-1",
        timeoutMs: 30_000,
        apiKey: "test-key",
        language: "zh"
      },
      (async (input: string | URL | Request, init?: RequestInit) => {
        requestUrl = String(input);
        requestBody = init?.body;
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer test-key"
        });
        return new Response(JSON.stringify({ text: "你好" }), {
          headers: {
            "content-type": "application/json"
          }
        });
      }) as typeof fetch
    );

    const result = await transcribe({
      localPath: audioPath,
      mimeType: "audio/mpeg",
      fileName: "voice.mp3"
    });

    expect(result.text).toBe("你好");
    expect(requestUrl).toBe("https://example.test/v1/audio/transcriptions");
    expect(requestBody).toBeInstanceOf(FormData);
  });
});
