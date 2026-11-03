/**
 * lib/git.js — 唯一调用 git 的地方。
 *
 * 规则：永远 spawn('git', argsArray) —— 不拼接字符串、不传 shell:true。
 * 工作区路径含中文与空格（E:\工作空间\DSH工作台改造），走 shell 会静默截断。
 */

import { spawn } from 'node:child_process';

/** 默认超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * 运行一次 git 命令。永不 reject —— 失败信息在返回值里。
 *
 * @param {string} cwd - 在哪个目录执行。
 * @param {string[]} args - 参数数组，不含 'git' 本身。
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runGit(cwd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (code, extraStderr = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: stdout.trimEnd(),
        stderr: (stderr + extraStderr).trimEnd(),
      });
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 进程可能已经退出 */
      }
      finish(-1, `\n[timeout after ${timeoutMs}ms]`);
    }, timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (error) => {
      finish(-1, error instanceof Error ? error.message : String(error));
    });

    child.on('close', (code) => {
      finish(typeof code === 'number' ? code : -1);
    });
  });
}

/**
 * 解析 `git status --porcelain=v1 -z` 的输出。
 *
 * -z 模式下每条记录是 `XY path`，记录之间用 \0 分隔，文件名不加密引号。
 * 重命名记录会有两个 \0 段（旧名、新名），这里取新名。
 *
 * @param {string} raw - 原始输出。
 * @returns {Array<{ path: string, status: 'M'|'A'|'D'|'U'|'??' }>}
 */
export function parsePorcelain(raw) {
  const rows = [];
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const record = parts[i];
    if (!record || record.length < 3) continue;
    const x = record[0];
    const y = record[1];
    const path = record.slice(3);
    if (!path) continue;

    let status;
    if (x === '?' && y === '?') status = '??';
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) status = 'U';
    else if (x === 'D' || y === 'D') status = 'D';
    else if (x === 'A') status = 'A';
    else status = 'M';

    rows.push({ path, status });

    // 重命名/复制后面跟着原路径那一段，跳过它
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i += 1;
  }
  return rows;
}

/**
 * 读取仓库当前变更。
 *
 * 返回值把「成功且没有改动」和「检测失败」分开——早先这里失败就 `return []`，
 * 面板于是把 git 报错显示成「没有变更，一切都是最新的」，用户看到的是最好
 * 听的那种谎话。
 *
 * `-uall` 让未跟踪目录展开到文件粒度：默认 `-u normal` 对一个新建目录只回
 * 一行 `newdir/`，而面板是按文件勾选、按文件看 diff 的。
 *
 * @param {string} cwd - 仓库目录。
 * @returns {Promise<{
 *   ok: boolean,
 *   changes: Array<{ path: string, status: 'M'|'A'|'D'|'U'|'??' }>,
 *   error: string | null,
 * }>}
 */
export async function gitStatus(cwd) {
  const r = await runGit(cwd, ['status', '--porcelain=v1', '-z', '-uall']);
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout || '').trim();
    return {
      ok: false,
      changes: [],
      // 空字符串会让面板显示成一片空白，兜一句人能看懂的话。
      error: detail || `git status 退出码 ${r.code}`,
    };
  }
  return { ok: true, changes: parsePorcelain(r.stdout), error: null };
}
