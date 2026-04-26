/**
 * cron 表达式解析（#116 step C.1）
 *
 * 支持：
 *   - 标准 5 字段 `分 时 日 月 周`，含 `*` / `a,b,c` / `a-b` / `* / N` / `a-b/N`
 *   - 别名 `@hourly` `@daily` `@weekly` `@monthly`
 *   - 区间触发 `@every Ns | Nm | Nh`（独立 interval 路径，非 5 字段映射）
 *
 * 时间语义：5 字段使用本地时区（与 crontab(5) 一致）。DST 切换日可能漏触发或重触发；
 * 用 `@every` 表达式可避开 DST。
 *
 * 不支持：6 字段秒级精度、`L` `W` `#` 等扩展。
 */

export type ParsedCron =
  | {
      kind: "fields";
      minute: number[];
      hour: number[];
      day: number[];
      month: number[];
      weekday: number[];
    }
  | {
      kind: "every";
      intervalMs: number;
    };

const FIELD_RANGE = {
  minute: [0, 59] as const,
  hour: [0, 23] as const,
  day: [1, 31] as const,
  month: [1, 12] as const,
  weekday: [0, 6] as const,
};

const ALIAS_FIELDS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const EVERY_RE = /^@every\s+(\d+)(s|m|h)$/i;

export function parseCronExpr(rawExpr: string): ParsedCron {
  const expr = rawExpr.trim();
  if (!expr) throw new Error("cron expression is empty");

  const everyMatch = expr.match(EVERY_RE);
  if (everyMatch) {
    const n = Number.parseInt(everyMatch[1], 10);
    const unit = everyMatch[2].toLowerCase();
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`invalid @every interval: ${rawExpr}`);
    }
    const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
    return { kind: "every", intervalMs: n * mult };
  }

  const aliased = ALIAS_FIELDS[expr.toLowerCase()] ?? expr;
  const parts = aliased.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `cron expression must have 5 fields (got ${parts.length}): ${rawExpr}`
    );
  }
  const [m, h, d, mon, w] = parts;
  return {
    kind: "fields",
    minute: parseField(m, FIELD_RANGE.minute[0], FIELD_RANGE.minute[1]),
    hour: parseField(h, FIELD_RANGE.hour[0], FIELD_RANGE.hour[1]),
    day: parseField(d, FIELD_RANGE.day[0], FIELD_RANGE.day[1]),
    month: parseField(mon, FIELD_RANGE.month[0], FIELD_RANGE.month[1]),
    weekday: parseWeekdayField(w),
  };
}

function parseWeekdayField(token: string): number[] {
  const raw = parseField(token, 0, 7);
  const norm = new Set<number>();
  for (const v of raw) norm.add(v === 7 ? 0 : v);
  return [...norm].sort((a, b) => a - b);
}

function parseField(token: string, min: number, max: number): number[] {
  if (!token) throw new Error("empty cron field");
  const out = new Set<number>();
  for (const part of token.split(",")) {
    if (!part) throw new Error(`invalid empty list segment in '${token}'`);
    let rangePart = part;
    let stepStr = "1";
    const slash = part.indexOf("/");
    if (slash >= 0) {
      rangePart = part.slice(0, slash) || "*";
      stepStr = part.slice(slash + 1);
    }
    const step = parseIntStrict(stepStr, `step in '${part}'`);
    if (step <= 0) throw new Error(`step must be > 0: ${part}`);

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const dashIdx = rangePart.indexOf("-");
      const a = parseIntStrict(rangePart.slice(0, dashIdx), `range start of '${part}'`);
      const b = parseIntStrict(rangePart.slice(dashIdx + 1), `range end of '${part}'`);
      lo = a;
      hi = b;
    } else {
      lo = parseIntStrict(rangePart, `value '${rangePart}'`);
      hi = slash >= 0 ? max : lo;
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`out-of-range field '${part}' for [${min},${max}]`);
    }
    for (let i = lo; i <= hi; i += step) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

function parseIntStrict(s: string, what = "integer"): number {
  if (!/^-?\d+$/.test(s)) throw new Error(`expected ${what}, got '${s}'`);
  return Number.parseInt(s, 10);
}

/**
 * 判断 cron 在 (since, now] 区间内是否触发（左开右闭，避免重复 fire 同 tick 的边界）。
 *
 * - fields kind：以本地时区按分钟边界遍历；分钟边界落在区间内且全部字段匹配则视为触发
 * - every kind：检查区间内是否跨越 intervalMs 边界（自 epoch 起）
 */
export function cronMatches(parsed: ParsedCron, since: number, now: number): boolean {
  if (now <= since) return false;
  if (parsed.kind === "every") {
    const sinceBoundary = Math.floor(since / parsed.intervalMs);
    const nowBoundary = Math.floor(now / parsed.intervalMs);
    return nowBoundary > sinceBoundary;
  }

  // 从 since 之后的下一个分钟边界开始；步长 1 分钟
  const firstMinTs = Math.floor(since / 60_000) * 60_000 + 60_000;
  for (let ts = firstMinTs; ts <= now; ts += 60_000) {
    if (matchesFieldsAt(parsed, ts)) return true;
  }
  return false;
}

function matchesFieldsAt(p: Extract<ParsedCron, { kind: "fields" }>, ts: number): boolean {
  const d = new Date(ts);
  if (!p.minute.includes(d.getMinutes())) return false;
  if (!p.hour.includes(d.getHours())) return false;
  if (!p.month.includes(d.getMonth() + 1)) return false;

  // crontab(5)：当 day 与 weekday 都受限时，任一匹配即触发；都为通配则始终视为通过此联合条件
  const dayWild = p.day.length === 31;
  const weekdayWild = p.weekday.length === 7;
  const dayMatch = p.day.includes(d.getDate());
  const weekdayMatch = p.weekday.includes(d.getDay());
  if (dayWild && weekdayWild) return true;
  if (dayWild) return weekdayMatch;
  if (weekdayWild) return dayMatch;
  return dayMatch || weekdayMatch;
}
