/**
 * CronPanel · #116 cron 任务管理 UI
 *
 * 列表 + 启停 + 立刻跑 + 删除 + 创建（template / 自定义）+ 最近运行历史
 * 后端：/v1/web/cron/tasks 等（cli.tsx web 子命令注入 cronManagerRef 时可用，否则 503）
 */

import { FormEvent, useEffect, useState } from "react";
import {
  addCronTask,
  installCronTemplate,
  listCronRuns,
  listCronTasks,
  listCronTemplates,
  removeCronTask,
  runCronNow,
  setCronTaskEnabled,
  type CronNotifyChannel,
  type CronRun,
  type CronTask,
  type CronTaskKind,
  type CronTaskTemplate,
} from "@/api/endpoints";

interface Props {
  onError(msg: string | null): void;
}

export default function CronPanel({ onError }: Props) {
  const [tasks, setTasks] = useState<CronTask[]>([]);
  const [templates, setTemplates] = useState<CronTaskTemplate[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cronUnavailable, setCronUnavailable] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [runs, setRuns] = useState<CronRun[]>([]);
  // P5.2：run-now 完成时短暂显示 toast，4s 后自动消失（替代 window.alert）
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function refresh() {
    try {
      const r = await listCronTasks();
      setTasks(r.tasks);
      setCronUnavailable(false);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("503") || msg.includes("cron-unavailable")) {
        setCronUnavailable(true);
      } else {
        onError(`cron 列表失败：${msg}`);
      }
    }
  }

  async function refreshTemplates() {
    try {
      const r = await listCronTemplates();
      setTemplates(r.templates);
    } catch {
      // templates 失败不阻塞
    }
  }

  useEffect(() => {
    refresh();
    refreshTemplates();
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleToggle(t: CronTask) {
    setBusy(true);
    try {
      await setCronTaskEnabled(t.id, !t.enabled);
      await refresh();
    } catch (err) {
      onError(`启停失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleRunNow(t: CronTask) {
    setBusy(true);
    try {
      const { run } = await runCronNow(t.id);
      onError(null);
      // P5.2：不再 window.alert；改 toast + 自动选中该任务 + 拉最新 runs 历史展示
      const ms = run.endedAt - run.startedAt;
      setToast({
        kind: run.status === "success" ? "ok" : "err",
        text: `[${t.name}] ${run.status} · ${ms}ms${run.error ? `   ERROR: ${run.error}` : ""}`,
      });
      // 4s 后自动清掉 toast
      window.setTimeout(() => setToast(null), 4000);
      // 自动定位 runs panel 到该任务
      setSelectedTaskId(t.id);
      try {
        const r = await listCronRuns(t.id, 20);
        setRuns(r.runs);
      } catch {
        // 拉历史失败不阻塞 toast
      }
      await refresh();
    } catch (err) {
      onError(`run-now 失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(t: CronTask) {
    if (!window.confirm(`删除任务 "${t.name}"？此操作不可撤销。`)) return;
    setBusy(true);
    try {
      await removeCronTask(t.id);
      await refresh();
    } catch (err) {
      onError(`删除失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleInstall(tpl: CronTaskTemplate) {
    setBusy(true);
    try {
      await installCronTemplate(tpl.key);
      await refresh();
    } catch (err) {
      onError(`安装模板失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSelectTask(t: CronTask) {
    setSelectedTaskId(t.id);
    try {
      const r = await listCronRuns(t.id, 20);
      setRuns(r.runs);
    } catch (err) {
      onError(`运行历史失败：${(err as Error).message}`);
    }
  }

  if (cronUnavailable) {
    return (
      <div className="p-6 text-sm">
        <div className="text-warning font-medium mb-2">Cron 不可用</div>
        <div className="text-muted">
          server 进程没有启用 cronManager。仅 <code className="text-fg">codeclaw web</code>{" "}
          子命令才有 cron host engine。如果你确认是 web 子命令启动的，请检查
          server 启动 log 是否报 <code>CodeClaw cron init failed</code>。
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full relative">
      {/* P5.2：run-now 完成 toast（替代 window.alert）；4s 后自动消失 */}
      {toast && (
        <div
          className={
            "absolute top-2 left-1/2 -translate-x-1/2 z-10 px-3 py-2 rounded shadow-lg text-xs " +
            (toast.kind === "ok"
              ? "bg-ok/20 text-ok border border-ok"
              : "bg-danger/20 text-danger border border-danger")
          }
        >
          <div className="flex items-center gap-2">
            <span className="font-mono">{toast.text}</span>
            <button
              onClick={() => setToast(null)}
              className="ml-2 text-muted hover:text-fg"
              aria-label="dismiss"
            >
              ×
            </button>
          </div>
        </div>
      )}
      {/* 左：任务列表 */}
      <div className="flex-1 p-3 overflow-y-auto border-r border-border min-w-0">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold">Cron 任务（{tasks.length}）</h2>
          <button
            disabled={busy}
            onClick={() => setShowAdd((v) => !v)}
            className="px-3 py-1 text-xs border border-border rounded hover:bg-bg/80"
          >
            {showAdd ? "取消" : "+ 新任务"}
          </button>
        </div>

        {showAdd && (
          <AddCronForm
            templates={templates}
            onInstall={handleInstall}
            onSubmit={async (input) => {
              setBusy(true);
              try {
                await addCronTask(input);
                setShowAdd(false);
                await refresh();
              } catch (err) {
                onError(`创建失败：${(err as Error).message}`);
              } finally {
                setBusy(false);
              }
            }}
            busy={busy}
          />
        )}

        {tasks.length === 0 && (
          <div className="text-xs text-muted px-2">无任务；点【+ 新任务】或安装模板</div>
        )}

        <ul className="flex flex-col gap-2 mt-2">
          {tasks.map((t) => (
            <li
              key={t.id}
              className={
                "border rounded p-2 cursor-pointer text-xs " +
                (selectedTaskId === t.id ? "border-accent bg-accent/10" : "border-border bg-bg")
              }
              onClick={() => handleSelectTask(t)}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono font-medium">{t.name}</span>
                <span
                  className={
                    "text-[10px] px-1.5 py-0.5 rounded " +
                    (t.enabled ? "bg-success/20 text-success" : "bg-muted/20 text-muted")
                  }
                >
                  {t.enabled ? "ENABLED" : "DISABLED"}
                </span>
              </div>
              <div className="text-muted mt-1">
                {t.schedule} · {t.kind} · notify=
                {(t.notifyChannels ?? ["cli"]).join("/")}
              </div>
              <div className="text-[10px] text-muted mt-1 truncate" title={t.payload}>
                {t.payload}
              </div>
              {t.lastRunAt && (
                <div className="text-[10px] mt-1">
                  最近：{new Date(t.lastRunAt).toLocaleString()}
                  {t.lastRunStatus && (
                    <span
                      className={
                        " " +
                        (t.lastRunStatus === "success" ? "text-success" : "text-danger")
                      }
                    >
                      {" "}
                      · {t.lastRunStatus}
                    </span>
                  )}
                </div>
              )}
              <div className="flex gap-1.5 mt-2" onClick={(e) => e.stopPropagation()}>
                <button
                  disabled={busy}
                  onClick={() => handleToggle(t)}
                  className="px-2 py-0.5 text-[10px] border border-border rounded hover:bg-bg/80"
                >
                  {t.enabled ? "暂停" : "启用"}
                </button>
                <button
                  disabled={busy}
                  onClick={() => handleRunNow(t)}
                  className="px-2 py-0.5 text-[10px] border border-border rounded hover:bg-bg/80"
                >
                  立即跑
                </button>
                <button
                  disabled={busy}
                  onClick={() => handleRemove(t)}
                  className="px-2 py-0.5 text-[10px] border border-danger/40 text-danger rounded hover:bg-danger/10"
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* 右：运行历史 */}
      <div className="w-[40%] p-3 overflow-y-auto min-w-0">
        <h2 className="text-sm font-bold mb-3">运行历史</h2>
        {!selectedTaskId && (
          <div className="text-xs text-muted">点左侧任务查看历史</div>
        )}
        {selectedTaskId && runs.length === 0 && (
          <div className="text-xs text-muted">暂无运行记录</div>
        )}
        <ul className="flex flex-col gap-2 text-xs">
          {runs.map((r, i) => (
            <li key={`${r.taskId}-${r.startedAt}-${i}`} className="border border-border rounded p-2 bg-bg">
              <div className="flex items-center justify-between">
                <span className="font-mono">
                  {new Date(r.startedAt).toLocaleString()}
                </span>
                <span
                  className={
                    "text-[10px] px-1.5 py-0.5 rounded " +
                    (r.status === "success" ? "bg-success/20 text-success" : "bg-danger/20 text-danger")
                  }
                >
                  {r.status}
                </span>
              </div>
              <div className="text-[10px] text-muted mt-1">
                {r.endedAt - r.startedAt}ms
              </div>
              <pre className="text-[10px] mt-2 whitespace-pre-wrap break-all max-h-32 overflow-y-auto bg-bg/40 p-1.5 rounded">
                {r.output.slice(0, 2048)}
                {r.error ? `\n\nERROR: ${r.error}` : ""}
              </pre>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

interface AddProps {
  templates: CronTaskTemplate[];
  onSubmit(input: {
    name: string;
    schedule: string;
    kind: CronTaskKind;
    payload: string;
    notifyChannels?: CronNotifyChannel[];
    timeoutMs?: number;
  }): Promise<void>;
  onInstall(tpl: CronTaskTemplate): Promise<void>;
  busy: boolean;
}

function AddCronForm({ templates, onSubmit, onInstall, busy }: AddProps) {
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("0 9 * * *");
  const [kind, setKind] = useState<CronTaskKind>("slash");
  const [payload, setPayload] = useState("");
  const [notify, setNotify] = useState<CronNotifyChannel[]>(["cli", "web"]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !schedule.trim() || !payload.trim()) return;
    await onSubmit({
      name: name.trim(),
      schedule: schedule.trim(),
      kind,
      payload: payload.trim(),
      notifyChannels: notify.length > 0 ? notify : undefined,
    });
    setName("");
    setPayload("");
  }

  function toggleNotify(ch: CronNotifyChannel) {
    setNotify((curr) =>
      curr.includes(ch) ? curr.filter((c) => c !== ch) : [...curr, ch]
    );
  }

  return (
    <div className="border border-border rounded p-3 mb-3 bg-bg/40 text-xs">
      {templates.length > 0 && (
        <div className="mb-3">
          <div className="font-medium mb-1.5">从模板安装：</div>
          <div className="flex flex-wrap gap-1.5">
            {templates.map((t) => (
              <button
                key={t.key}
                disabled={busy}
                onClick={() => onInstall(t)}
                className="px-2 py-1 text-[10px] border border-border rounded hover:bg-bg/80"
                title={t.description}
              >
                {t.key}
              </button>
            ))}
          </div>
        </div>
      )}

      <form onSubmit={submit} className="flex flex-col gap-2">
        <div className="font-medium">或手动创建：</div>
        <input
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="任务名（唯一）"
          className="px-2 py-1 bg-bg border border-border rounded font-mono"
        />
        <input
          type="text"
          required
          value={schedule}
          onChange={(e) => setSchedule(e.target.value)}
          placeholder="cron 表达式 (如 0 9 * * *) / @hourly / @every 5m"
          className="px-2 py-1 bg-bg border border-border rounded font-mono"
        />
        <div className="flex gap-2">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as CronTaskKind)}
            className="px-2 py-1 bg-bg border border-border rounded flex-1"
          >
            <option value="slash">slash</option>
            <option value="prompt">prompt</option>
            <option value="shell">shell</option>
          </select>
          <div className="flex gap-1.5 items-center">
            {(["cli", "web", "wechat"] as CronNotifyChannel[]).map((ch) => (
              <label key={ch} className="flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={notify.includes(ch)}
                  onChange={() => toggleNotify(ch)}
                />
                {ch}
              </label>
            ))}
          </div>
        </div>
        <textarea
          required
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          placeholder={
            kind === "slash"
              ? "/rag index"
              : kind === "shell"
                ? "npm audit --production"
                : "Review the commits added to this repo in the past 7 days..."
          }
          rows={3}
          className="px-2 py-1 bg-bg border border-border rounded font-mono"
        />
        <button
          type="submit"
          disabled={busy}
          className="px-3 py-1 bg-accent text-white rounded font-medium disabled:opacity-50"
        >
          创建任务
        </button>
      </form>
    </div>
  );
}
