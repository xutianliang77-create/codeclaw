/**
 * RAG embedding · OpenAI-compatible /v1/embeddings 调用（M4-#75 step c）
 *
 * 设计：
 *   - 协议走 OpenAI 兼容接口；LM Studio / Ollama / OpenAI / 任意第三方均可
 *   - 默认模型留空让用户在 settings.embedModel 指定（如 'bge-m3' / 'text-embedding-3-small'）
 *   - 批量请求：单次最多 64 文本（避免超 max_tokens）
 *   - 响应解析：data[i].embedding 取 number[]；维度自适应
 *
 * 持久化：
 *   - 向量序列化为 Float32Array → ArrayBuffer → Buffer（BLOB）
 *   - 反序列化对称：Buffer → Float32Array → number[]
 *   - rag_chunks.embedding 存这个 BLOB（store.ts 已预留字段）
 *
 * 不在本步：cosine search / RRF 融合 → step d
 */

const DEFAULT_BATCH = 64;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface EmbedOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  batchSize?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function embedTexts(
  texts: ReadonlyArray<string>,
  opts: EmbedOptions
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const batch = Math.max(1, Math.min(opts.batchSize ?? DEFAULT_BATCH, 256));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const out: number[][] = [];

  for (let i = 0; i < texts.length; i += batch) {
    const slice = texts.slice(i, i + batch);
    const vectors = await embedBatch(slice, opts, fetchImpl);
    out.push(...vectors);
  }
  return out;
}

async function embedBatch(
  inputs: ReadonlyArray<string>,
  opts: EmbedOptions,
  fetchImpl: typeof fetch
): Promise<number[][]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(joinUrl(opts.baseUrl, "/embeddings"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: opts.model, input: inputs as string[] }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`embedding request failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data?: Array<{ embedding?: unknown; index?: number }> };
    if (!Array.isArray(json.data)) {
      throw new Error("embedding response has no data array");
    }
    // 按 index 排序后取 embedding
    return json.data
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((entry, i) => coerceVector(entry.embedding, i));
  } finally {
    clearTimeout(timer);
  }
}

function coerceVector(v: unknown, idx: number): number[] {
  if (!Array.isArray(v)) {
    throw new Error(`embedding[${idx}] is not array`);
  }
  return v.map((x, j) => {
    const n = typeof x === "number" ? x : Number(x);
    if (!Number.isFinite(n)) {
      throw new Error(`embedding[${idx}][${j}] is not finite number`);
    }
    return n;
  });
}

function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

/* ---------- BLOB 序列化 ---------- */

export function vectorToBlob(v: number[]): Buffer {
  const f32 = new Float32Array(v);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function blobToVector(buf: Buffer): number[] {
  // Buffer 对齐：复制成新 ArrayBuffer 防 Float32Array 视图越界
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const f32 = new Float32Array(ab);
  return Array.from(f32);
}

/* ---------- cosine 相似度 ---------- */

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
