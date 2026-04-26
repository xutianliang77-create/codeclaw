/**
 * cron 任务模板单测（#116 阶段 🅑）
 */

import { describe, expect, it } from "vitest";
import {
  CRON_TEMPLATES,
  formatTemplateList,
  getTemplate,
  listTemplates,
} from "../../../src/cron/templates";

describe("CRON_TEMPLATES", () => {
  it("至少含 5 个 builtin 模板（daily-rag / weekly-review / hourly-audit / graph-rebuild / session-summary）", () => {
    expect(CRON_TEMPLATES.length).toBeGreaterThanOrEqual(5);
    const keys = CRON_TEMPLATES.map((t) => t.key);
    for (const k of [
      "daily-rag",
      "weekly-review",
      "hourly-audit",
      "graph-rebuild",
      "session-summary",
    ]) {
      expect(keys).toContain(k);
    }
  });

  it("每个模板字段完整", () => {
    for (const t of CRON_TEMPLATES) {
      expect(t.key).toBeTruthy();
      expect(t.schedule).toBeTruthy();
      expect(["slash", "prompt", "shell"]).toContain(t.kind);
      expect(t.payload).toBeTruthy();
      expect(t.defaultName).toBeTruthy();
    }
  });

  it("listTemplates 返回拷贝（不共享引用）", () => {
    const a = listTemplates();
    const b = listTemplates();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("getTemplate", () => {
  it("已知 key", () => {
    expect(getTemplate("daily-rag")?.kind).toBe("slash");
  });
  it("未知 key → null", () => {
    expect(getTemplate("nope")).toBe(null);
  });
});

describe("formatTemplateList", () => {
  it("含表头 key / schedule", () => {
    const txt = formatTemplateList();
    expect(txt).toContain("key");
    expect(txt).toContain("schedule");
    expect(txt).toContain("daily-rag");
  });
});
