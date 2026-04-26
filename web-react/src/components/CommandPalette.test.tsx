import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import CommandPalette from "./CommandPalette";

describe("CommandPalette", () => {
  beforeEach(() => {
    delete window.codeclawComposer;
  });
  afterEach(() => {
    delete window.codeclawComposer;
  });

  it("默认关闭，⌘K 打开", () => {
    render(<CommandPalette onPick={() => undefined} />);
    expect(screen.queryByPlaceholderText(/搜命令/)).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByPlaceholderText(/搜命令/)).toBeInTheDocument();
  });

  it("Esc 关闭", () => {
    render(<CommandPalette onPick={() => undefined} />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByPlaceholderText(/搜命令/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByPlaceholderText(/搜命令/)).not.toBeInTheDocument();
  });

  it("输入 'rag' 后 Enter 调 onPick + 注入 composer", () => {
    const setInput = vi.fn();
    window.codeclawComposer = { setInput, focus: () => undefined };
    const onPick = vi.fn();
    render(<CommandPalette onPick={onPick} />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = screen.getByPlaceholderText(/搜命令/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "rag" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalled();
    // 选中的应是 /rag（因 scoreEntry name 前缀加权）
    const picked = onPick.mock.calls[0][0] as { name: string };
    expect(picked.name).toBe("/rag");
    expect(setInput).toHaveBeenCalledWith("/rag ");
  });

  it("无匹配 query 显示 '无匹配'", () => {
    render(<CommandPalette onPick={() => undefined} />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = screen.getByPlaceholderText(/搜命令/);
    fireEvent.change(input, { target: { value: "zzzzzzz" } });
    expect(screen.getByText("无匹配")).toBeInTheDocument();
  });
});
