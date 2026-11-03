/**
 * export.js — 把当前机器的 ~/.dsh 刷新进快照仓库的 layer/。
 *
 * 为什么面板需要这个按钮：
 *
 *   面板操作的是 dsh-sync/layer/，那是 ~/.dsh 的**副本**。用户改了技能、
 *   改了宪法，副本不会自己变。以前必须切到终端跑一行 node bin/export.cjs
 *   --layer-only，忘了跑就直接推送 —— 推上去的是三天前的旧快照。这是真实
 *   发生过的事故（layer/AGENTS.md 1740 字 vs ~/.dsh/AGENTS.md 535 字）。
 *
 * 只跑 --layer-only：带会话的完整导出要十几秒、且会让 layer 体积暴涨，
 * 不适合挂在按钮上。会话搬家仍然走 bin/make-package.cjs。
 */

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

/** 导出脚本相对仓库根的位置。 */
export const EXPORT_SCRIPT = join('bin', 'export.cjs');

/** 导出最多等 60 秒 —— 层文件不多，超过就是卡住了。 */
const TIMEOUT_MS = 60000;

/**
 * 仓库里有没有那个导出脚本。
 *
 * 面板可以被指到任意 git 仓库（用户填错路径、或者想同步别的项目）。
 * 那种仓库没有 bin/export.cjs —— 此时按钮应该老实说「这里没法导出」，
 * 而不是报一个 ENOENT 让用户以为坏了。
 *
 * @param {string} cwd 仓库根
 * @param {{ access?: Function }} [fsImpl]
 * @returns {Promise<boolean>}
 */
export async function hasExporter(cwd, fsImpl = { access }) {
  if (typeof cwd !== 'string' || cwd === '') return false;
  try {
    await fsImpl.access(join(cwd, EXPORT_SCRIPT));
    return true;
  } catch {
    return false;
  }
}

/**
 * 跑一次层导出。
 *
 * 用 node 显式执行而不是 `export.cjs` 直接跑：Windows 上 .cjs 没有可执行
 * 关联，靠 shebang 是不行的。也不开 shell —— cwd 可能是含中文和空格的路径。
 *
 * 永不 reject：面板要拿这段文字当结果展示，抛异常就只剩一个空白的红框。
 *
 * @param {object} options
 * @param {string} options.cwd 仓库根
 * @param {{ spawn?: Function, access?: Function }} [options.impl] 测试注入
 * @returns {Promise<{ ok: boolean, message: string, output?: string }>}
 */
export async function exportLayer({ cwd, impl = {} } = {}) {
  const spawnImpl = impl.spawn ?? spawn;
  const fsImpl = { access: impl.access ?? access };

  if (!(await hasExporter(cwd, fsImpl))) {
    return { ok: false, message: `这个仓库里没有 ${EXPORT_SCRIPT}，没法从本机导出` };
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(process.execPath, [EXPORT_SCRIPT, '--layer-only'], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ok: false, message: `启动导出失败：${error instanceof Error ? error.message : String(error)}` });
      return;
    }

    let out = '';
    let err = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      // 超时不杀进程只报告，是因为导出可能在写一半；杀掉留半截 layer
      // 比慢更危险。让用户自己看到超时，再决定。
      finish({ ok: false, message: `导出超过 ${TIMEOUT_MS / 1000} 秒仍未结束，已放弃等待` });
    }, TIMEOUT_MS);
    // 不阻止进程退出：宿主里这个定时器不该拖住整个进程
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout?.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      err += String(chunk);
    });
    child.on('error', (error) => {
      finish({ ok: false, message: `导出进程出错：${error instanceof Error ? error.message : String(error)}` });
    });
    child.on('close', (code) => {
      const output = (out + err).trim();
      if (code === 0) {
        finish({ ok: true, message: '已从本机导出到快照仓库', output });
        return;
      }
      finish({
        ok: false,
        message: `导出失败（退出码 ${code}）`,
        output,
      });
    });
  });
}
