/**
 * 烟雾测试：scaffold 能渲染连接屏（B.1 验收）
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "./App";

describe("App scaffold", () => {
  it("无 token → 显示 Connect 屏", () => {
    localStorage.clear();
    render(<App />);
    expect(screen.getByText(/CodeClaw · Web/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/CODECLAW_WEB_TOKEN/)).toBeInTheDocument();
  });
});
