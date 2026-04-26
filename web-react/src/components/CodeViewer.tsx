/**
 * Monaco viewer 包装（B.10）
 *
 * 仅 viewer：readOnly + 关闭 minimap + 禁 contextmenu。
 * lazy-load：通过 dynamic import + React.lazy + Suspense；首屏不下载 monaco-editor 主包。
 *
 * 用法：
 *   <CodeViewer code={txt} language="typescript" maxHeight={400} />
 *
 * 决策：
 *   - 小代码块（< 30 行 / < 1KB）继续走 react-markdown 路径；不走 Monaco（bundle 浪费）
 *   - 大代码块 / 路径含 .ts .tsx .py 等 / diff 显示 → 用 Monaco
 */

import { lazy, Suspense, useEffect, useState } from "react";

// Self-host Monaco：默认 @monaco-editor/react 走 CDN，离线不可用。
// 通过 loader.config({ monaco }) 切到本地 npm 包。整段 lazy import 触发后才执行。
const monacoModule = import("@monaco-editor/react").then(async (m) => {
  const mod = await import("monaco-editor");
  m.loader.config({ monaco: mod });
  return m;
});

const MonacoEditor = lazy(() =>
  monacoModule.then((m) => ({ default: m.default }))
);
const MonacoDiffEditor = lazy(() =>
  monacoModule.then((m) => ({ default: m.DiffEditor }))
);

export interface CodeViewerProps {
  code: string;
  language?: string;
  /** 默认 480 px 上限 */
  maxHeight?: number;
  /** 文件名提示（路径里的扩展名用于推断 language）*/
  filePath?: string;
}

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  h: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  sh: "shell",
  bash: "shell",
  yaml: "yaml",
  yml: "yaml",
  json: "json",
  md: "markdown",
  html: "html",
  css: "css",
  sql: "sql",
};

function inferLanguage(path?: string): string {
  if (!path) return "plaintext";
  const ext = path.split(".").pop()?.toLowerCase();
  return EXT_TO_LANG[ext ?? ""] ?? "plaintext";
}

function useResolvedTheme(): "vs-dark" | "vs" {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-theme") === "dark"
  );
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setDark(document.documentElement.getAttribute("data-theme") === "dark");
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return dark ? "vs-dark" : "vs";
}

export default function CodeViewer({
  code,
  language,
  maxHeight = 480,
  filePath,
}: CodeViewerProps) {
  const lang = language ?? inferLanguage(filePath);
  const theme = useResolvedTheme();
  const lineCount = code.split("\n").length;
  const computedHeight = Math.min(maxHeight, Math.max(120, lineCount * 19 + 16));

  return (
    <Suspense fallback={<pre className="bg-bg p-2 rounded text-xs font-mono whitespace-pre-wrap">{code}</pre>}>
      <div className="border border-border rounded overflow-hidden">
        <MonacoEditor
          height={computedHeight}
          language={lang}
          value={code}
          theme={theme}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            renderLineHighlight: "none",
            contextmenu: false,
            fontSize: 12,
            lineNumbers: "on",
            folding: true,
            wordWrap: "on",
            automaticLayout: true,
          }}
        />
      </div>
    </Suspense>
  );
}

export interface CodeDiffProps {
  oldCode: string;
  newCode: string;
  language?: string;
  maxHeight?: number;
  filePath?: string;
}

export function CodeDiff({ oldCode, newCode, language, maxHeight = 480, filePath }: CodeDiffProps) {
  const lang = language ?? inferLanguage(filePath);
  const theme = useResolvedTheme();
  return (
    <Suspense fallback={<pre className="bg-bg p-2 rounded text-xs font-mono">[loading diff…]</pre>}>
      <div className="border border-border rounded overflow-hidden">
        <MonacoDiffEditor
          height={maxHeight}
          language={lang}
          original={oldCode}
          modified={newCode}
          theme={theme}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            renderSideBySide: true,
            scrollBeyondLastLine: false,
            contextmenu: false,
            fontSize: 12,
            automaticLayout: true,
          }}
        />
      </div>
    </Suspense>
  );
}
