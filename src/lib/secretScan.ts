/**
 * Secret 扫描器 · W4-05/06
 *
 * 在 /commit 预览阶段扫描 git diff，命中常见凭据 pattern 时 reply 里警告。
 * 同样可被其他场景复用（/ask 上传文件、Web upload 中间件等）。
 *
 * 设计取舍：
 *   - 规则集**保守**（宁愿漏报也不大量误报）：只匹配一眼可识别的强 pattern，
 *     如 AWS AKIA / GitHub ghp_ / OpenAI sk- / 私钥头等。
 *   - 不对结果做指纹去重——同一 pattern 重复出现是有价值信号（攻击者 spam？）。
 *   - 只做扫描，不阻止执行；调用方决定怎么报警 / 阻塞。
 */

export interface SecretRule {
  /** 规则名，便于报警时定位 */
  name: string;
  /** 正则；推荐 g 标志，扫描器会逐个 match 收集 */
  pattern: RegExp;
  /** 风险等级；high 触发硬警告，medium 仅提示 */
  severity: "high" | "medium";
  /** 一句话描述：what & why */
  description: string;
}

export interface SecretFinding {
  rule: string;
  severity: "high" | "medium";
  /** 命中片段（已截断到 64 字符防泄露） */
  match: string;
  /** 命中位于 input 的起始偏移（字符数） */
  index: number;
  /** 1-based 行号（按 \n 分） */
  line: number;
}

/** 默认规则集——按经验排序：常见且高确信度优先。*/
export const DEFAULT_RULES: SecretRule[] = [
  {
    name: "aws-access-key",
    severity: "high",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    description: "AWS Access Key ID（IAM/STS）",
  },
  {
    name: "github-token",
    severity: "high",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b/g,
    description: "GitHub personal/oauth/server/refresh token",
  },
  // anthropic 必须排在 openai 前：openai 的 sk- 通配也会匹配 sk-ant-，
  // 扫描器对同一段落会都报；但放前面才能让 r[0] 是 anthropic-key，更精确
  {
    name: "anthropic-key",
    severity: "high",
    pattern: /\bsk-ant-[0-9A-Za-z_-]{20,}\b/g,
    description: "Anthropic API key",
  },
  {
    name: "openai-key",
    severity: "high",
    // negative lookahead 排除 sk-ant-（Anthropic 单独算）
    pattern: /\bsk-(?!ant-)[0-9A-Za-z_-]{20,}\b/g,
    description: "OpenAI API key（含 sk-proj- project key 变体）",
  },
  {
    name: "google-api-key",
    severity: "high",
    pattern: /\bAIza[0-9A-Za-z_-]{35,}\b/g,
    description: "Google API key（GCP / Maps / etc.）",
  },
  {
    name: "slack-token",
    severity: "high",
    pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g,
    description: "Slack token（bot/user/app/refresh/SOCKET）",
  },
  {
    name: "private-key-header",
    severity: "high",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/g,
    description: "PEM 私钥头",
  },
  {
    name: "jwt-likely",
    severity: "medium",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    description: "JWT 形似（三段 base64url）",
  },
  {
    name: "generic-password-assign",
    severity: "medium",
    pattern: /(?:password|passwd|pwd)\s*[=:]\s*["'][^"'\n]{6,}["']/gi,
    description: "硬编码密码赋值（password=\"...\"）",
  },
];

/**
 * 扫描文本，返回所有命中。**不抛**——pattern 错误（理论不会发生，规则 hardcode）
 * 也只会跳过该规则。
 *
 * 性能：对 10 KB 输入 + 9 条默认规则 < 1 ms。Bigger inputs 仍 O(n*rules)，
 * 不针对超大文件优化（调用方应当先按 maxBytes 截）。
 */
export function scanForSecrets(
  text: string,
  rules: SecretRule[] = DEFAULT_RULES
): SecretFinding[] {
  if (!text) return [];
  const findings: SecretFinding[] = [];

  // 预算行号：[start, end) 区间
  const newlineIdx: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) newlineIdx.push(i);
  }
  const lineOf = (idx: number): number => {
    // 二分找第一个 newline >= idx；行号 = 该 newline 的下标 + 1
    let lo = 0, hi = newlineIdx.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (newlineIdx[mid] >= idx) hi = mid;
      else lo = mid + 1;
    }
    return lo + 1;
  };

  for (const rule of rules) {
    // 必须 g 标志才能 exec 多次；缺则一次
    const re = rule.pattern.global
      ? rule.pattern
      : new RegExp(rule.pattern.source, rule.pattern.flags + "g");
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const matched = m[0];
      findings.push({
        rule: rule.name,
        severity: rule.severity,
        match: matched.length > 64 ? matched.slice(0, 64) + "…" : matched,
        index: m.index,
        line: lineOf(m.index),
      });
      // 避免 zero-width 死循环
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return findings;
}

/** 把 findings 渲染成给人看的多行报告（/commit reply 用）*/
export function formatFindings(findings: SecretFinding[]): string {
  if (findings.length === 0) return "no secrets detected.";
  const grouped: Record<string, SecretFinding[]> = {};
  for (const f of findings) {
    (grouped[f.rule] ??= []).push(f);
  }
  const lines: string[] = [
    `⚠️ POTENTIAL SECRETS DETECTED · ${findings.length} hits`,
  ];
  for (const [rule, hits] of Object.entries(grouped)) {
    lines.push(`  - ${rule} [${hits[0].severity}]: ${hits.length} hit(s)`);
    for (const h of hits.slice(0, 3)) {
      lines.push(`      L${h.line}: ${h.match}`);
    }
    if (hits.length > 3) lines.push(`      ... and ${hits.length - 3} more`);
  }
  lines.push("Review the diff carefully before committing or sharing.");
  return lines.join("\n");
}
