import { describe, it, expect } from "vitest";
import { parseLocalDate, localYMD } from "../src/dateParser";

describe("parseLocalDate · 时区无关", () => {
  it("returns the same calendar day across runs", () => {
    const d = parseLocalDate("2024-12-31");
    expect(localYMD(d)).toEqual([2024, 12, 31]);
  });

  it("handles month boundary", () => {
    const d = parseLocalDate("2024-03-01");
    expect(localYMD(d)).toEqual([2024, 3, 1]);
  });

  it("midnight is local 00:00", () => {
    const d = parseLocalDate("2024-06-15");
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
  });
});
