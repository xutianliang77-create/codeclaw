/**
 * ⌘K Command Palette（B.9）
 *
 * - 全局快捷键：⌘K / Ctrl+K 打开；ESC 关；Up/Down 选；Enter 插入到 composer
 * - 模糊搜 36 个 slash 命令
 * - 选中后通过 window.codeclawComposer.setInput(text) 注入 chat composer
 *   （ChatPane mount 时挂；未连接时此 hook 缺失，操作变成只复制到 clipboard）
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  fuzzyMatch,
  scoreEntry,
  SLASH_COMMANDS,
  type SlashEntry,
} from "@/lib/slashCommands";

interface Props {
  /** 选中后的回调；通常注入到 chat composer */
  onPick(entry: SlashEntry): void;
}

declare global {
  interface Window {
    codeclawComposer?: {
      setInput(text: string): void;
      focus(): void;
    };
  }
}

export default function CommandPalette({ onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 全局 ⌘K / Ctrl+K
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (isCmdK) {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // 打开时聚焦输入框 + 重置
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim();
    const candidates = q
      ? SLASH_COMMANDS.filter((e) =>
          fuzzyMatch(q, e.name) ||
          fuzzyMatch(q, e.summary) ||
          fuzzyMatch(q, e.category)
        )
      : SLASH_COMMANDS;
    return [...candidates].sort((a, b) => scoreEntry(q, b) - scoreEntry(q, a));
  }, [query]);

  function pick(entry: SlashEntry): void {
    setOpen(false);
    onPick(entry);
    const text = entry.template ?? `${entry.name} `;
    if (window.codeclawComposer) {
      window.codeclawComposer.setInput(text);
      window.codeclawComposer.focus();
    } else if (navigator.clipboard) {
      void navigator.clipboard.writeText(text).catch(() => undefined);
    }
  }

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[active]) pick(filtered[active]);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/40"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[640px] max-w-[90vw] max-h-[60vh] bg-bg border border-border rounded-lg shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border p-2.5 flex items-center gap-2">
          <span className="text-muted text-xs font-mono">⌘K</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKey}
            placeholder="搜命令 / 类别 / 摘要..."
            className="flex-1 bg-transparent outline-none text-sm"
          />
          <span className="text-muted text-xs">{filtered.length} / {SLASH_COMMANDS.length}</span>
        </div>
        <ul className="flex-1 overflow-y-auto">
          {filtered.map((e, i) => (
            <li
              key={e.name}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(e)}
              className={
                "px-3 py-2 cursor-pointer flex items-center gap-3 " +
                (i === active ? "bg-accent/10" : "hover:bg-bg/80")
              }
            >
              <span className="font-mono text-sm w-32 shrink-0">{e.name}</span>
              <span className="text-xs flex-1 text-muted truncate">{e.summary}</span>
              <span className="text-[10px] uppercase text-muted shrink-0">{e.category}</span>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-3 py-8 text-center text-muted text-sm">无匹配</li>
          )}
        </ul>
        <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted flex gap-3">
          <span>↑↓ 选择</span>
          <span>Enter 插入</span>
          <span>ESC 关闭</span>
        </div>
      </div>
    </div>
  );
}
