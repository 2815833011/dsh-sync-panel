// test/ahead-behind.test.mjs
//
// countAhead / countBehind 决定主按钮长什么样，所以它们的「拿不到就退让」
// 行为必须钉死：宁可少报一个数字，也不要在断网或全新仓库时把按钮点亮成
// 一个跑不通的动作。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countAhead, countBehind } from '../lib/ops.js';

/** 按调用顺序吐预置返回值的假 git。 */
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

const UP_OK = { code: 0, stdout: 'origin/main' };

test('countAhead：有 upstream 时数 @{u}..HEAD', async () => {
  const git = fakeGit([
    UP_OK,                       // rev-parse @{u}
    { code: 0, stdout: '3' },    // rev-list --count @{u}..HEAD
  ]);
  assert.equal(await countAhead('/repo', git), 3);
  assert.equal(git.calls[1], 'rev-list --count @{u}..HEAD');
});

test('countAhead：无 upstream 时退回 origin/<branch>', async () => {
  const git = fakeGit([
    { code: 128, stderr: 'fatal: no upstream' }, // rev-parse @{u}
    { code: 0, stdout: 'main' },                 // rev-parse --abbrev-ref HEAD
    { code: 0, stdout: 'abc123' },               // rev-parse --verify origin/main
    { code: 0, stdout: '2' },                    // rev-list --count origin/main..HEAD
  ]);
  assert.equal(await countAhead('/repo', git), 2);
  assert.equal(git.calls[3], 'rev-list --count origin/main..HEAD');
});

test('countAhead：远端没有同名分支时，本地有提交就算欠推', async () => {
  const git = fakeGit([
    { code: 128, stderr: 'fatal: no upstream' },
    { code: 0, stdout: 'main' },
    { code: 1, stderr: 'fatal: Needed a single revision' }, // origin/main 不存在
    { code: 0, stdout: 'abc123' },                          // HEAD 存在
  ]);
  assert.equal(await countAhead('/repo', git), 1);
});

test('countAhead：远端没有同名分支且本地也没提交时返回 0', async () => {
  const git = fakeGit([
    { code: 128, stderr: 'fatal: no upstream' },
    { code: 0, stdout: 'main' },
    { code: 1, stderr: 'fatal: Needed a single revision' },
    { code: 128, stderr: 'fatal: Needed a single revision' }, // HEAD 也没有
  ]);
  assert.equal(await countAhead('/repo', git), 0);
});

test('countAhead：git 抛异常时返回 0，不冒泡', async () => {
  const git = { runGit: async () => { throw new Error('boom'); } };
  assert.equal(await countAhead('/repo', git), 0);
});

test('countBehavior：countBehind 数 HEAD..@{u}', async () => {
  const git = fakeGit([
    UP_OK,
    { code: 0, stdout: '5' },
  ]);
  assert.equal(await countBehind('/repo', git), 5);
  assert.equal(git.calls[1], 'rev-list --count HEAD..@{u}');
});

test('countBehind：无 upstream 时退回 origin/<branch>', async () => {
  const git = fakeGit([
    { code: 128, stderr: 'fatal: no upstream' },
    { code: 0, stdout: 'main' },
    { code: 0, stdout: 'abc123' },
    { code: 0, stdout: '4' },
  ]);
  assert.equal(await countBehind('/repo', git), 4);
  assert.equal(git.calls[3], 'rev-list --count HEAD..origin/main');
});

test('countBehind：没有可比对的远端引用时返回 0', async () => {
  const git = fakeGit([
    { code: 128, stderr: 'fatal: no upstream' },
    { code: 0, stdout: 'main' },
    { code: 1, stderr: 'fatal: Needed a single revision' },
  ]);
  assert.equal(await countBehind('/repo', git), 0);
});

test('countBehind：rev-list 失败时返回 0', async () => {
  const git = fakeGit([UP_OK, { code: 128, stderr: 'boom' }]);
  assert.equal(await countBehind('/repo', git), 0);
});

test('countBehind：git 抛异常时返回 0，不冒泡', async () => {
  const git = { runGit: async () => { throw new Error('boom'); } };
  assert.equal(await countBehind('/repo', git), 0);
});
