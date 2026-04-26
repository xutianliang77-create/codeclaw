/**
 * 附件文本提取（M2-05）
 *
 * 当 LLM 收到 EngineFileAttachment 时把内容转成文本注入 message.content：
 *   - 文本类（.txt/.md/.csv/.log/.json/.xml/.yaml/.yml/.ts/.js/.py/.go/.rs/.sh）：
 *     直接 utf8 decode
 *   - .pdf：pdf-parse v1.1.1（ESM 默认 import OK，PoC 已验证）；5s timeout 防卡 multi-turn
 *   - 其他扩展名：返 "[unsupported attachment type: .xxx]" marker
 *   - 大于 1MB 截断 + 末尾 "...[truncated at 1048576 bytes]"
 *
 * 不抛错——即使 PDF parse 挂掉也返 "[pdf parse failed: ...]"，让上层流不中断。
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const MAX_ATTACHMENT_BYTES = 1024 * 1024; // 1 MB
export const PDF_PARSE_TIMEOUT_MS = 5000;

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".csv",
  ".log",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".sh",
  ".bash",
  ".rb",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".html",
  ".css",
  ".scss",
  ".sql",
  ".toml",
  ".ini",
]);

export async function extractAttachmentText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(filePath);
  } catch (err) {
    return `[attachment read failed: ${err instanceof Error ? err.message : String(err)}]`;
  }
  const truncated = st.size > MAX_ATTACHMENT_BYTES;
  let buf: Buffer;
  try {
    const full = await readFile(filePath);
    buf = full.subarray(0, MAX_ATTACHMENT_BYTES);
  } catch (err) {
    return `[attachment read failed: ${err instanceof Error ? err.message : String(err)}]`;
  }

  let text: string;
  if (TEXT_EXTENSIONS.has(ext)) {
    text = buf.toString("utf8");
  } else if (ext === ".pdf") {
    text = await parsePdfWithTimeout(buf, PDF_PARSE_TIMEOUT_MS);
  } else {
    return `[unsupported attachment type: ${ext || "(none)"}]`;
  }

  if (truncated) {
    text += `\n\n...[truncated at ${MAX_ATTACHMENT_BYTES} bytes]`;
  }
  return text;
}

async function parsePdfWithTimeout(buf: Buffer, timeoutMs: number): Promise<string> {
  let pdfDefault: ((b: Buffer) => Promise<{ text: string }>) | null = null;
  try {
    // pdf-parse 无 .d.ts；用 unknown 转型避免 implicit any
    const mod = (await import("pdf-parse" as string)) as { default: (b: Buffer) => Promise<{ text: string }> };
    pdfDefault = mod.default;
  } catch (err) {
    return `[pdf-parse import failed: ${err instanceof Error ? err.message : String(err)}]`;
  }
  const racePromise = pdfDefault(buf).then((r) => r.text);
  const timeoutPromise = new Promise<string>((_resolve, reject) =>
    setTimeout(() => reject(new Error(`pdf-parse timeout after ${timeoutMs}ms`)), timeoutMs)
  );
  try {
    return await Promise.race([racePromise, timeoutPromise]);
  } catch (err) {
    return `[pdf parse failed: ${err instanceof Error ? err.message : String(err)}]`;
  }
}
