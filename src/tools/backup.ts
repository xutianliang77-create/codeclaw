/**
 * Write 工具备份 · #93 T16
 *
 * 防御场景：并发写入 / 误操作覆盖；目标文件被 write/append/replace 覆盖前先备份。
 *
 * 设计：
 *   - 备份位置：~/.codeclaw/backups/<yyyymmdd-HHMMSS>-<rand4>/<workspace-rel-path>
 *   - 同 batch 多次写入用同一 ts 目录（按进程启动时 + 1s 粒度）
 *   - 文件不存在 → 跳过备份（write 是新建语义）
 *   - 失败时不阻塞 write（仅 console.warn 记录）
 *   - 大文件（> 10MB）跳过（避免 backup 撑爆）；记 console.warn
 *
 * 不做：
 *   - retention 清理（留给 nightly cron 增量做）
 *   - 加密 backup（个人版偏裸，留 P2）
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

const MAX_BACKUP_FILE_BYTES = 10 * 1024 * 1024;

/** 进程启动时分配一次 batch dir 名；同进程多次 write 共用同一目录 */
let cachedBatchDir: string | null = null;

function batchDirName(now: Date = new Date()): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = randomBytes(2).toString("hex");
  return `${stamp}-${rand}`;
}

export function defaultBackupRoot(): string {
  return path.join(os.homedir(), ".codeclaw", "backups");
}

/** 仅测试 / 显式重置时调；正常使用走 cachedBatchDir lazy 初始化 */
export function resetBackupBatch(): void {
  cachedBatchDir = null;
}

/**
 * 写入前备份。target 不存在时返回 null（write 是新建）。
 * 失败 → console.warn，不抛（write 操作本身不应被备份失败阻塞）。
 */
export function backupFileIfExists(
  absoluteTargetPath: string,
  workspace: string,
  opts: { backupRoot?: string; now?: Date } = {}
): string | null {
  if (!existsSync(absoluteTargetPath)) return null;

  let stats;
  try {
    stats = statSync(absoluteTargetPath);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;
  if (stats.size > MAX_BACKUP_FILE_BYTES) {
     
    console.warn(
      `[backup] skipped: ${absoluteTargetPath} size ${stats.size} exceeds ${MAX_BACKUP_FILE_BYTES}`
    );
    return null;
  }

  if (cachedBatchDir === null) cachedBatchDir = batchDirName(opts.now);
  const root = opts.backupRoot ?? defaultBackupRoot();

  // 计算相对 workspace 的路径（防 absoluteTargetPath 出 workspace 时跌出 root）
  const rel = path.relative(workspace, absoluteTargetPath);
  // 用 path.posix.normalize 防 Windows 路径分隔符进 backup 目录名
  const safeRel = rel.split(path.sep).join(path.posix.sep).replace(/^(\.\.\/)+/, "_outside_/");
  const dest = path.join(root, cachedBatchDir, safeRel);

  try {
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(absoluteTargetPath, dest);
    return dest;
  } catch (err) {
     
    console.warn(`[backup] failed: ${absoluteTargetPath} → ${dest}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
