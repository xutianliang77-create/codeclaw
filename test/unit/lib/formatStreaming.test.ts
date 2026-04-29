import { describe, expect, it } from "vitest";
import { formatElapsed, formatTokenCount } from "../../../src/lib/formatStreaming";

describe("formatElapsed", () => {
  it("[v0.8.6] < 1s 显示 0s", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(500)).toBe("0s");
    expect(formatElapsed(999)).toBe("0s");
  });

  it("[v0.8.6] < 60s 显示秒", () => {
    expect(formatElapsed(1_000)).toBe("1s");
    expect(formatElapsed(45_000)).toBe("45s");
    expect(formatElapsed(59_999)).toBe("59s");
  });

  it("[v0.8.6] 整分钟省略秒", () => {
    expect(formatElapsed(60_000)).toBe("1m");
    expect(formatElapsed(120_000)).toBe("2m");
  });

  it("[v0.8.6] 含余秒显示 m + s", () => {
    expect(formatElapsed(83_000)).toBe("1m 23s");
    expect(formatElapsed(125_000)).toBe("2m 5s");
  });

  it("[v0.8.6] 整小时省略分钟", () => {
    expect(formatElapsed(3_600_000)).toBe("1h");
    expect(formatElapsed(7_200_000)).toBe("2h");
  });

  it("[v0.8.6] 含余分钟显示 h + m", () => {
    expect(formatElapsed(3_900_000)).toBe("1h 5m");
    expect(formatElapsed(5_700_000)).toBe("1h 35m");
  });
});

describe("formatTokenCount", () => {
  it("[v0.8.6] < 1k 显示原始数", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(42)).toBe("42");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("[v0.8.6] 1k - 10k 显示一位小数", () => {
    expect(formatTokenCount(1000)).toBe("1.0k");
    expect(formatTokenCount(1234)).toBe("1.2k");
    expect(formatTokenCount(9999)).toBe("10.0k");
  });

  it("[v0.8.6] 10k - 1M 显示整数 k", () => {
    expect(formatTokenCount(10_000)).toBe("10k");
    expect(formatTokenCount(123_456)).toBe("123k");
    expect(formatTokenCount(999_999)).toBe("1000k");
  });

  it("[v0.8.6] >= 1M 显示一位小数 M", () => {
    expect(formatTokenCount(1_000_000)).toBe("1.0M");
    expect(formatTokenCount(2_500_000)).toBe("2.5M");
  });
});
