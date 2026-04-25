/**
 * SafeTextInput · 替代 ink-text-input 的本地实现
 *
 * 起因：ink-text-input@6 + ink@5 的组合在多个终端下 backspace / arrow
 * 表现不稳——编辑长文本（如 baseUrl）时删除/增加字符出错。
 * 此组件用 ink.useInput 直接消费键码，行为可控可测。
 *
 * 不变量：
 *   - ESC 不被捕获（外层 useInput 可以接到 → 例如回主菜单）
 *   - Enter 触发 onSubmit
 *   - Ctrl+C 不被捕获（让外层 useInput 决定退出）
 *   - 所有可见字符（input 非 undefined 且非控制键）都进 buffer
 *   - cursor 位置可视化（反色块）
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";

export interface SafeTextInputProps {
  value: string;
  onChange(next: string): void;
  onSubmit?(final: string): void;
  placeholder?: string;
  /** 是否激活按键监听；外层切屏时设 false 避免错误消费 */
  isActive?: boolean;
  /** 隐藏内容（密码模式） */
  mask?: boolean;
}

export function SafeTextInput({
  value,
  onChange,
  onSubmit,
  placeholder = "",
  isActive = true,
  mask = false,
}: SafeTextInputProps): React.JSX.Element {
  const [cursor, setCursor] = useState<number>(value.length);

  // 当外部 value 变化（例如复用已有内容首次进入编辑），保持 cursor 在末尾
  useEffect(() => {
    if (cursor > value.length) {
      setCursor(value.length);
    }
  }, [value, cursor]);

  useInput(
    (input, key) => {
      // Enter
      if (key.return) {
        onSubmit?.(value);
        return;
      }

      // ESC 不消费（让外层 useInput 处理，例如回主菜单）
      if (key.escape) {
        return;
      }

      // Ctrl+C 不消费（让外层退出）
      if (key.ctrl && input === "c") {
        return;
      }

      // Backspace / DEL 兼容：
      //   - ink 5 在某些终端下 key.backspace / key.delete flag 不可靠
      //   - **快速连按 backspace 时 ink 会把多个 \x7f 合并到一次事件的 input 里**
      //     （已实测：按 4 次 → input 含 4 个 \x7f）
      //   - raw 字节：\x7f (DEL, Linux/macOS) 或 \x08 (BS, Windows/Telnet)
      // 因此：用 regex 数 input 中的 \x7f/\x08 字符个数决定要删几个字符。
      const bsMatches = (input ?? "").match(/[\x7f\x08]/g);
      const bsCount = bsMatches?.length ?? 0;
      const isBackspaceFlag = key.backspace || key.delete;
      if (bsCount > 0 || isBackspaceFlag) {
        const reduce = Math.min(Math.max(bsCount, isBackspaceFlag ? 1 : 0), cursor);
        if (reduce > 0) {
          const next = value.slice(0, cursor - reduce) + value.slice(cursor);
          onChange(next);
          setCursor(cursor - reduce);
        }
        return;
      }

      // 左右箭头
      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(value.length, c + 1));
        return;
      }

      // Home / End（ink 暴露为 ctrl+a / ctrl+e 习惯）
      if (key.ctrl && input === "a") {
        setCursor(0);
        return;
      }
      if (key.ctrl && input === "e") {
        setCursor(value.length);
        return;
      }

      // Ctrl+U：清行
      if (key.ctrl && input === "u") {
        onChange("");
        setCursor(0);
        return;
      }

      // Ctrl+W：删一个 word
      if (key.ctrl && input === "w") {
        if (cursor === 0) return;
        const head = value.slice(0, cursor);
        // 跳过尾随空白，再删到下一段空白
        const trimmed = head.replace(/\s+$/, "");
        const lastSpace = trimmed.lastIndexOf(" ");
        const cutAt = lastSpace >= 0 ? lastSpace + 1 : 0;
        onChange(value.slice(0, cutAt) + value.slice(cursor));
        setCursor(cutAt);
        return;
      }

      // 上下箭头 / Tab：在单行输入里忽略
      if (key.upArrow || key.downArrow || key.tab) {
        return;
      }

      // 其它带 ctrl/meta 的组合键忽略
      if (key.ctrl || key.meta) {
        return;
      }

      // 普通字符输入（含粘贴大段文本，input 可能是多字符）
      if (input && input.length > 0) {
        const next = value.slice(0, cursor) + input + value.slice(cursor);
        onChange(next);
        setCursor(cursor + input.length);
      }
    },
    { isActive }
  );

  // 渲染：empty + placeholder
  if (!value && placeholder) {
    return <Text color="gray">{placeholder}</Text>;
  }

  const display = mask ? "*".repeat(value.length) : value;

  // 显式 cursor block：反色一个字符；末尾则在最后追加一个反色空格
  const before = display.slice(0, cursor);
  const atChar = display[cursor];
  const after = display.slice(cursor + 1);

  return (
    <Box>
      <Text>{before}</Text>
      <Text inverse>{atChar ?? " "}</Text>
      <Text>{after}</Text>
    </Box>
  );
}

export default SafeTextInput;
