/**
 * tokenize 单测（M4-#75 step b）
 */

import { describe, expect, it } from "vitest";
import { tokenize, tokenFreqs } from "../../../src/rag/tokenize";

describe("tokenize", () => {
  it("普通英文按空格切", () => {
    expect(tokenize("hello world")).toEqual(["hello", "world"]);
  });

  it("特殊字符当分隔符", () => {
    expect(tokenize("foo.bar/baz-qux")).toEqual(["foo", "bar", "baz", "qux"]);
  });

  it("单字符 token 过滤", () => {
    expect(tokenize("a foo b bar")).toEqual(["foo", "bar"]);
  });

  it("数字保留（长度 ≥ 2 的 token）", () => {
    // 单字符 "0" 被 MIN_TOKEN_LEN 过滤；"v1" / "v2" 长度 2 保留
    expect(tokenize("user42 v1 v2.0")).toEqual(["user42", "v1", "v2"]);
  });

  it("下划线保留为同一 token", () => {
    expect(tokenize("user_id snake_case")).toEqual(["user_id", "snake_case"]);
  });

  it("转小写", () => {
    expect(tokenize("FooBar UPPER")).toEqual(["foobar", "upper"]);
  });

  it("空字符串 / 全分隔符", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   --  ::")).toEqual([]);
  });
});

describe("tokenFreqs", () => {
  it("统计每 token 频率", () => {
    expect(tokenFreqs("foo foo bar foo baz bar")).toEqual(
      new Map([
        ["foo", 3],
        ["bar", 2],
        ["baz", 1],
      ])
    );
  });

  it("空文本 → 空 map", () => {
    expect(tokenFreqs("")).toEqual(new Map());
  });
});
