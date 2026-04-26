import { useEffect, useState } from "react";
import { getStatusLine } from "@/api/endpoints";

export default function StatusLine() {
  const [text, setText] = useState("...");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const r = await getStatusLine();
        if (cancelled) return;
        setText(r.text);
        setUpdatedAt(r.lastUpdate);
      } catch {
        if (!cancelled) setText("[status line failed]");
      }
    }
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <footer className="flex justify-between px-4 py-1.5 text-xs text-muted border-t border-border font-mono">
      <span>{text}</span>
      <span>
        {updatedAt ? new Date(updatedAt).toLocaleTimeString() : ""} · 5s 轮询
      </span>
    </footer>
  );
}
