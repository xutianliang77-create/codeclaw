import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type {
  WechatAudioAttachment,
  WechatCachedAudio,
  WechatCachedImage,
  WechatImageAttachment
} from "./types";

type FetchLike = typeof fetch;

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function resolveCachedFileName(baseName: string, extension: string, originalFileName?: string): string {
  return originalFileName?.trim() || `${baseName}${extension}`;
}

function inferExtension(image: WechatImageAttachment): string {
  const fileName = image.fileName?.trim();
  if (fileName) {
    const extension = path.extname(fileName);
    if (extension) {
      return extension;
    }
  }

  const mimeType = image.mimeType?.toLowerCase();
  if (mimeType === "image/png") {
    return ".png";
  }
  if (mimeType === "image/webp") {
    return ".webp";
  }
  if (mimeType === "image/gif") {
    return ".gif";
  }

  return ".jpg";
}

function inferAudioExtension(audio: WechatAudioAttachment): string {
  const fileName = audio.fileName?.trim();
  if (fileName) {
    const extension = path.extname(fileName);
    if (extension) {
      return extension;
    }
  }

  const mimeType = audio.mimeType?.toLowerCase();
  if (mimeType === "audio/mpeg" || mimeType === "audio/mp3") {
    return ".mp3";
  }
  if (mimeType === "audio/wav" || mimeType === "audio/x-wav") {
    return ".wav";
  }
  if (mimeType === "audio/ogg") {
    return ".ogg";
  }
  if (mimeType === "audio/mp4" || mimeType === "audio/aac") {
    return ".m4a";
  }
  if (mimeType === "audio/amr") {
    return ".amr";
  }

  return ".mp3";
}

function inferMimeType(dataUrl: string, mimeType?: string): string | undefined {
  if (mimeType) {
    return mimeType;
  }

  const match = dataUrl.match(/^data:([^;,]+)[;,]/i);
  return match?.[1];
}

function extractDataUrlBuffer(dataUrl: string, label: string): Buffer {
  const match = dataUrl.match(/^data:[^;,]+;base64,(.+)$/i);
  if (!match) {
    throw new Error(`Unsupported WeChat ${label} data URL`);
  }

  return Buffer.from(match[1], "base64");
}

export function resolveWechatMediaCacheDir(homeDir = homedir()): string {
  return path.join(homeDir, ".codeclaw", "wechat-media");
}

export async function cacheWechatImageAttachment(options: {
  messageId: string;
  image: WechatImageAttachment;
  fetchImpl?: FetchLike;
  cacheDir?: string;
}): Promise<WechatCachedImage | null> {
  const image = options.image;
  if (!image.dataUrl && !image.url) {
    return null;
  }

  const cacheDir = options.cacheDir ?? resolveWechatMediaCacheDir();
  await mkdir(cacheDir, { recursive: true });

  let fileBuffer: Buffer;
  let sizeBytes = image.sizeBytes;

  if (image.dataUrl) {
    fileBuffer = extractDataUrlBuffer(image.dataUrl, "image");
    sizeBytes ??= fileBuffer.byteLength;
  } else {
    const response = await (options.fetchImpl ?? fetch)(image.url as string);
    if (!response.ok) {
      throw new Error(`WeChat image download failed: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    fileBuffer = Buffer.from(arrayBuffer);
    sizeBytes ??= fileBuffer.byteLength;
  }

  const fileNameBase =
    sanitizeSegment(options.messageId) ||
    `wechat-image-${Date.now().toString(36)}`;
  const extension = inferExtension(image);
  const fileName = resolveCachedFileName(fileNameBase, extension, image.fileName);
  const localPath = path.join(cacheDir, `${fileNameBase}${extension}`);

  await writeFile(localPath, fileBuffer);

  return {
    localPath,
    mimeType: image.dataUrl ? inferMimeType(image.dataUrl, image.mimeType) : image.mimeType,
    fileName,
    width: image.width,
    height: image.height,
    sizeBytes,
    sourceUrl: image.url
  };
}

export async function cacheWechatAudioAttachment(options: {
  messageId: string;
  audio: WechatAudioAttachment;
  fetchImpl?: FetchLike;
  cacheDir?: string;
}): Promise<WechatCachedAudio | null> {
  const audio = options.audio;
  if (!audio.dataUrl && !audio.url) {
    return null;
  }

  const cacheDir = options.cacheDir ?? resolveWechatMediaCacheDir();
  await mkdir(cacheDir, { recursive: true });

  let fileBuffer: Buffer;
  let sizeBytes = audio.sizeBytes;

  if (audio.dataUrl) {
    fileBuffer = extractDataUrlBuffer(audio.dataUrl, "audio");
    sizeBytes ??= fileBuffer.byteLength;
  } else {
    const response = await (options.fetchImpl ?? fetch)(audio.url as string);
    if (!response.ok) {
      throw new Error(`WeChat audio download failed: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    fileBuffer = Buffer.from(arrayBuffer);
    sizeBytes ??= fileBuffer.byteLength;
  }

  const fileNameBase =
    sanitizeSegment(options.messageId) ||
    `wechat-audio-${Date.now().toString(36)}`;
  const extension = inferAudioExtension(audio);
  const fileName = resolveCachedFileName(fileNameBase, extension, audio.fileName);
  const localPath = path.join(cacheDir, `${fileNameBase}${extension}`);

  await writeFile(localPath, fileBuffer);

  return {
    localPath,
    mimeType: audio.dataUrl ? inferMimeType(audio.dataUrl, audio.mimeType) : audio.mimeType,
    fileName,
    durationMs: audio.durationMs,
    sizeBytes,
    sourceUrl: audio.url
  };
}
