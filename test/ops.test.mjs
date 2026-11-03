// test/ops.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { push, pull, rollback, listRecent } from '../lib/ops.js';

/**
 * 假 git：按调用顺序吐预置返回值，并记录每次调用的参数。
 * @param {Array<{code:number, stdout?:string, stderr?:string}>} responses
 */
function fakeGit(responses) {
  let i = 0;
  const calls = [];
  return {
    calls,
    runGit: async (cwd, args) => {
      calls.push(args.join(' '));
      const r = responses[i++] ?? { code: 0, stdout: '', stderr: '' };
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
  };
}

/** 有 upstream 时的 push 前置序列：add / diff / commit / rev-parse @{u} */
const HAS_UPSTREAM = [
  { code: 0, stdout: '' },                 // add
  { code: 0, stdout: 'a.md' },             // diff --cached --name-only
  { code: 0, stdout: '[main abc1234] sync' }, // commit
  { code: 0, stdout: 'origin/main' },      // rev-parse @{u}：已有上游
];

/** 无 upstream 时的 push 前置序列 */
const NO_UPSTREAM = [
  { code: 0, stdout: '' },                 // add
  { code: 0, stdout: 'a.md' },             // diff --cached
  { code: 0, stdout: '[main abc1234] sync' }, // commit
  { code: 128, stdout: '', stderr: "fatal: no upstream configured for branch 'main'" }, // @{u}
  { code: 0, stdout: 'main' },             // rev-parse --abbrev-ref HEAD
];

const fakeState = {
  writes: [],
  logs: [],
  writeLast: async function (r) { this.writes.push(r); },
  appendLog: async function (l) { this.logs.push(l); },
};

function freshState() {
  return {
    writes: [],
    logs: [],
    writeLast: async function (r) { this.writes.push(r); },
    appendLog: async function (l) { this.logs.push(l); },
  };
}

test('push 无改动时不 commit，返回 committed: 0', async () => {
  const git = fakeGit([{ code: 0, stdout: '' }]);
  const r = await push({ cwd: '/repo', paths: ['a.md'], git, state: fakeState });
  assert.equal(r.ok, true);
  assert.equal(r.committed, 0);
  assert.ok(!git.calls.some((c) => c.startsWith('commit')), `不应 commit: ${git.calls.join(' | ')}`);
});

test('push 暂存后无实际变更时 committed 为 0', async () => {
  const git = fakeGit([
    { code: 0, stdout: 'M  a.md' },
    { code: 0, stdout: '' },
    { code: 0, stdout: '' },
  ]);
  const r = await push({ cwd: '/repo', paths: ['a.md'], git, state: fakeState });
  assert.equal(r.ok, true);
  assert.equal(r.committed, 0);
  assert.ok(!git.calls.some((c) => c.startsWith('commit')));
});

test('push commit 失败时回滚暂存区', async () => {
  const git = fakeGit([
    { code: 0, stdout: '' },            // add
    { code: 0, stdout: 'a.md' },        // diff --cached --name-only：有暂存内容
    { code: 1, stdout: '', stderr: 'nothing to commit' }, // commit 失败
    { code: 0, stdout: '' },            // reset
  ]);
  const r = await push({ cwd: '/repo', paths: ['a.md'], git, state: fakeState });
  assert.equal(r.ok, false);
  assert.ok(git.calls.some((c) => c.startsWith('reset')), `期望调用 reset，实际: ${git.calls.join(' | ')}`);
});

test('push 成功后推到远端', async () => {
  const git = fakeGit([
    ...HAS_UPSTREAM,
    { code: 0, stdout: '' },            // push
    { code: 0, stdout: 'abc1234' },     // rev-parse --short HEAD
  ]);
  const r = await push({ cwd: '/repo', paths: ['a.md'], git, state: fakeState });
  assert.equal(r.ok, true);
  assert.equal(r.committed, 1);
  assert.ok(git.calls.some((c) => c.startsWith('push')));
});

test('push 失败时返回 git 的 stderr 便于排查', async () => {
  const git = fakeGit([
    ...HAS_UPSTREAM,
    { code: 1, stdout: '', stderr: 'rejected: non-fast-forward' }, // push
    { code: 0, stdout: 'abc1234' },     // rev-parse --short HEAD（失败后仍取 sha）
  ]);
  const r = await push({ cwd: '/repo', paths: ['a.md'], git, state: fakeState });
  assert.equal(r.ok, false);
  assert.equal(r.committed, 1);
  assert.match(r.error, /non-fast-forward/);
});

test('push 遇到没有 upstream 的分支时自动 --set-upstream', async () => {
  const git = fakeGit([
    ...NO_UPSTREAM,
    { code: 0, stdout: '' },            // push --set-upstream origin main
    { code: 0, stdout: 'abc1234' },     // rev-parse --short HEAD
  ]);
  const r = await push({ cwd: '/repo', paths: ['a.md'], git, state: fakeState });
  assert.equal(r.ok, true);
  const pushCall = git.calls.find((c) => c.startsWith('push'));
  assert.ok(pushCall, `应调用 push: ${git.calls.join(' | ')}`);
  assert.match(pushCall, /--set-upstream/);
  assert.match(pushCall, /origin main/);
});

test('无 upstream 且推送失败时明确标记 localOnly，不当成完全失败', async () => {
  const git = fakeGit([
    ...NO_UPSTREAM,
    { code: 128, stdout: '', stderr: 'remote: Permission denied' }, // push 失败
    { code: 0, stdout: 'abc1234' },     // rev-parse --short HEAD
  ]);
  const r = await push({ cwd: '/repo', paths: ['a.md'], git, state: fakeState });
  assert.equal(r.ok, false);
  assert.equal(r.committed, 1, '提交已落地，必须如实报告');
  assert.equal(r.localOnly, true, '必须标记「本地成功、远端失败」');
  assert.match(r.message, /本地/);
});

test('推送失败时写入 last 记录并带 localOnly 标记', async () => {
  const state = freshState();
  const git = fakeGit([
    ...HAS_UPSTREAM,
    { code: 1, stdout: '', stderr: 'rejected' },
    { code: 0, stdout: 'deadbee' },
  ]);
  await push({ cwd: '/repo', paths: ['a.md'], git, state });
  const last = state.writes.at(-1);
  assert.ok(last, '应写入 last 记录');
  assert.equal(last.localOnly, true);
  assert.equal(last.sha, 'deadbee');
});

test('push 越界路径被丢弃，不交给 git', async () => {
  const git = fakeGit([
    ...HAS_UPSTREAM,
    { code: 0, stdout: '' },
    { code: 0, stdout: 'abc1234' },
  ]);
  const r = await push({ cwd: '/repo', paths: ['../etc/passwd', 'a.md'], git, state: fakeState });
  assert.ok(!git.calls.some((c) => c.includes('passwd')), `越界路径不应进 git: ${git.calls.join(' | ')}`);
  assert.equal(r.ok, true);
  assert.ok(git.calls.some((c) => c.includes('a.md')), '合法路径应进 git');
});

test('push 全部路径越界时直接拒绝', async () => {
  const git = fakeGit([]);
  const r = await push({ cwd: '/repo', paths: ['../etc/passwd'], git, state: fakeState });
  assert.equal(r.ok, false);
  assert.ok(
    !git.calls.some((c) => c.startsWith('add')),
    `越界路径不应交给 git add: ${git.calls.join(' | ')}`,
  );
  assert.ok(!git.calls.some((c) => c.includes('passwd')));
});

test('工作区干净但有欠推提交时，push 把旧提交推上去', async () => {
  const git = fakeGit([
    { code: 0, stdout: '' },          // add
    { code: 0, stdout: '' },          // diff --cached：干净
    { code: 0, stdout: 'origin/main' }, // @{u} 存在
    { code: 0, stdout: '1' },         // rev-list --count：有 1 条欠推
    { code: 0, stdout: 'origin/main' }, // ensureUpstream 再查一次
    { code: 0, stdout: '' },          // push
    { code: 0, stdout: 'abc1234' },   // rev-parse --short
  ]);
  const r = await push({ cwd: '/repo', paths: ['a.md'], git, state: freshState() });
  assert.equal(r.ok, true);
  assert.equal(r.committed, 0, '没有新提交');
  assert.ok(git.calls.some((c) => c.startsWith('push')), '但仍要推送');
  assert.match(r.message, /欠推/);
});

test('工作区干净且无欠推时，push 不产生空提交', async () => {
  const git = fakeGit([
    { code: 0, stdout: '' },          // add
    { code: 0, stdout: '' },          // diff --cached
    { code: 0, stdout: 'origin/main' }, // @{u}
    { code: 0, stdout: '0' },         // rev-list：无欠推
  ]);
  const r = await push({ cwd: '/repo', paths: ['a.md'], git, state: fakeState });
  assert.equal(r.ok, true);
  assert.equal(r.committed, 0);
  assert.ok(!git.calls.some((c) => c.startsWith('push')), '无事可做时不该调 push');
});

test('没有 upstream 且远端无同名分支时，视为全部欠推', async () => {
  const git = fakeGit([
    { code: 0, stdout: '' },              // add
    { code: 0, stdout: '' },              // diff --cached：干净
    { code: 128, stdout: '', stderr: 'no upstream' }, // @{u}
    { code: 0, stdout: 'main' },          // rev-parse --abbrev-ref HEAD
    { code: 128, stdout: '' },            // rev-parse --verify origin/main：不存在
    { code: 128, stdout: '', stderr: 'no upstream' }, // ensureUpstream 再查
    { code: 0, stdout: 'main' },          // rev-parse --abbrev-ref HEAD
    { code: 0, stdout: '' },              // push --set-upstream
    { code: 0, stdout: 'abc1234' },       // rev-parse --short
  ]);
  const r = await push({ cwd: '/repo', paths: ['a.md'], git, state: freshState() });
  assert.equal(r.ok, true);
  assert.ok(git.calls.some((c) => c.includes('--set-upstream')));
});

test('pull 冲突时 abort 并返回冲突文件', async () => {
  const git = fakeGit([
    { code: 0, stdout: '' },
    { code: 1, stdout: 'CONFLICT (content): Merge conflict in a.md', stderr: '' },
    { code: 0, stdout: 'a.md' },
    { code: 0, stdout: '' },
  ]);
  const r = await pull({ cwd: '/repo', git, state: fakeState });
  assert.equal(r.ok, false);
  assert.deepEqual(r.conflicts, ['a.md']);
  assert.ok(git.calls.some((c) => c.includes('merge --abort')));
});

test('pull 无冲突时完成合并（--no-ff 由 merge 自身生成合并提交）', async () => {
  const git = fakeGit([
    { code: 0, stdout: '' },
    { code: 0, stdout: 'Merge made by the ort strategy.' },
  ]);
  const r = await pull({ cwd: '/repo', git, state: fakeState });
  assert.equal(r.ok, true);
  assert.deepEqual(r.conflicts, []);
  assert.ok(
    git.calls.some((c) => c.includes('merge') && c.includes('--no-ff')),
    `期望 merge --no-ff: ${git.calls.join(' | ')}`,
  );
  assert.ok(!git.calls.some((c) => c.includes('--abort')), '成功时不应 abort');
});

test('pull fetch 失败时不动工作区', async () => {
  const git = fakeGit([{ code: 128, stdout: '', stderr: 'could not resolve host' }]);
  const r = await pull({ cwd: '/repo', git, state: fakeState });
  assert.equal(r.ok, false);
  assert.match(r.error, /resolve host/);
  assert.ok(!git.calls.some((c) => c.includes('merge')), '拉取失败不应尝试合并');
});

test('rollback 对不存在的目标报错而不执行 revert', async () => {
  const git = fakeGit([{ code: 128, stdout: '', stderr: 'bad revision' }]);
  const r = await rollback({ cwd: '/repo', target: 'deadbeef', git, state: fakeState });
  assert.equal(r.ok, false);
  assert.match(r.error, /bad revision|不存在/);
  assert.ok(!git.calls.some((c) => c.startsWith('revert')), '目标无效时不应尝试 revert');
});

test('rollback 成功时生成 revert 提交并推送', async () => {
  const git = fakeGit([
    { code: 0, stdout: 'abc1234' },
    { code: 0, stdout: '[main def5678] Revert "sync"' },
    { code: 0, stdout: '' },
  ]);
  const r = await rollback({ cwd: '/repo', target: 'abc1234', git, state: fakeState });
  assert.equal(r.ok, true);
  assert.ok(git.calls.some((c) => c.startsWith('revert')));
  assert.ok(git.calls.some((c) => c.startsWith('push')));
});

test('rollback revert 失败时 abort', async () => {
  const git = fakeGit([
    { code: 0, stdout: 'abc1234' },
    { code: 1, stdout: '', stderr: 'conflict' },
    { code: 0, stdout: '' },
  ]);
  const r = await rollback({ cwd: '/repo', target: 'abc1234', git, state: fakeState });
  assert.equal(r.ok, false);
  assert.ok(git.calls.some((c) => c.includes('revert --abort')), `期望 revert --abort: ${git.calls.join(' | ')}`);
});

test('listRecent 解析提交历史', async () => {
  const git = fakeGit([
    {
      code: 0,
      stdout:
        'abc1234\u001fsync: 2026-10-29\u001f2026-10-29T10:00:00+08:00\n' +
        'def5678\u001finit\u001f2026-10-28T09:00:00+08:00',
    },
  ]);
  const rows = await listRecent({ cwd: '/repo', count: 5, git });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sha, 'abc1234');
  assert.equal(rows[0].subject, 'sync: 2026-10-29');
  assert.equal(rows[1].sha, 'def5678');
});
