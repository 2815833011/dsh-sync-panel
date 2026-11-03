/**
 * export.test.mjs — 层导出按钮的后端行为。
 *
 * 两个容易做错的地方，各自一个测试：
 *   1. 面板可以被指到任何 git 仓库，没有 bin/export.cjs 时要给一句人话，
 *      而不是把 ENOENT 甩到界面上。
 *   2. 导出失败时不能静默成功 —— 用户会以为快照是新的，然后推上去旧内容。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportLayer, hasExporter, EXPORT_SCRIPT } from '../lib/export.js';

/** 造一个假的 spawn：按给定行为吐 stdout 并以 code 退出。 */
function makeSpawn({ code = 0, stdout = '', stderr = '', throwOnSpawn = null } = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    if (throwOnSpawn) throw new Error(throwOnSpawn);
    calls.push({ cmd, args, opts });
    const stdoutHandlers = [];
    const stderrHandlers = [];
    const closeHandlers = [];
    const errorHandlers = [];
    const child = {
      stdout: { on: (_e, fn) => stdoutHandlers.push(fn) },
      stderr: { on: (_e, fn) => stderrHandlers.push(fn) },
      on: (event, fn) => {
        if (event === 'close') closeHandlers.push(fn);
        if (event === 'error') errorHandlers.push(fn);
      },
      kill() {},
    };
    // 下一个 microtask 再触发，模拟真实异步
    queueMicrotask(() => {
      if (stdout) for (const fn of stdoutHandlers) fn(Buffer.from(stdout));
      if (stderr) for (const fn of stderrHandlers) fn(Buffer.from(stderr));
      for (const fn of closeHandlers) fn(code);
    });
    return child;
  };
  return { spawn, calls };
}

/** 造一个 access：给定路径存在或不存在。 */
function makeFs({ exists = true } = {}) {
  const seen = [];
  return {
    seen,
    access: async (p) => {
      seen.push(p);
      if (!exists) throw new Error('ENOENT');
    },
  };
}

test('仓库里没有导出脚本时给出人话，而不是 ENOENT', async () => {
  const { spawn, calls } = makeSpawn();
  const fs = makeFs({ exists: false });
  const result = await exportLayer({ cwd: 'E:/some/other/repo', impl: { spawn, access: fs.access } });
  assert.equal(result.ok, false);
  assert.match(result.message, /没有/);
  assert.match(result.message, /bin[\\/]export\.cjs/);
  assert.equal(calls.length, 0, '没有脚本就不该启动子进程');
});

test('有脚本时用当前 node 显式执行 export.cjs --layer-only', async () => {
  const { spawn, calls } = makeSpawn({ code: 0, stdout: 'layer 已更新\n' });
  const fs = makeFs();
  const result = await exportLayer({ cwd: 'E:/工作空间/dsh-sync', impl: { spawn, access: fs.access } });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.cmd, process.execPath, '必须用当前 node，不能指望 .cjs 自己能跑');
  assert.deepEqual(call.args, [EXPORT_SCRIPT, '--layer-only'], '只导层，不碰会话');
  assert.equal(call.opts.cwd, 'E:/工作空间/dsh-sync');
  assert.equal(call.opts.windowsHide, true);
  assert.notEqual(call.opts.shell, true, '路径含空格，走 shell 会被截断');
});

test('导出失败时把退出码和输出一起交回去', async () => {
  const { spawn } = makeSpawn({ code: 1, stderr: 'ENOSPC: no space left\n' });
  const fs = makeFs();
  const result = await exportLayer({ cwd: 'E:/x', impl: { spawn, access: fs.access } });
  assert.equal(result.ok, false, '退出码非 0 必须报失败');
  assert.match(result.message, /退出码 1/);
  assert.match(result.output, /ENOSPC/, '要把 stderr 带回来，否则用户不知道哪儿坏了');
});

test('spawn 自己抛错（比如 node 路径不对）也不 reject', async () => {
  const { spawn } = makeSpawn({ throwOnSpawn: 'EACCES' });
  const fs = makeFs();
  const result = await exportLayer({ cwd: 'E:/x', impl: { spawn, access: fs.access } });
  assert.equal(result.ok, false);
  assert.match(result.message, /启动导出失败/);
});

test('进程报 error 事件时同样给失败而不是挂住', async () => {
  const spawn = () => {
    const errorHandlers = [];
    const child = {
      stdout: { on() {} },
      stderr: { on() {} },
      on: (event, fn) => {
        if (event === 'error') errorHandlers.push(fn);
      },
      kill() {},
    };
    queueMicrotask(() => {
      for (const fn of errorHandlers) fn(new Error('ENOENT'));
    });
    return child;
  };
  const fs = makeFs();
  const result = await exportLayer({ cwd: 'E:/x', impl: { spawn, access: fs.access } });
  assert.equal(result.ok, false);
  assert.match(result.message, /导出进程出错/);
});

test('hasExporter 只认仓库根下的 bin/export.cjs', async () => {
  assert.equal(await hasExporter('', { access: async () => {} }), false, '空目录直接 false');
  assert.equal(await hasExporter('E:/repo', { access: async () => {} }), true);
});
