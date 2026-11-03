// test/change-detection.test.mjs
//
// 钉死两个「变更检测不灵敏」的真根因：
//
//   A. gitStatus 在 git 失败时返回空数组，与「真的没有改动」无法区分。
//      面板于是把「检测失败」显示成「没有变更，一切都是最新的」——
//      用户看到的是最坏的那种谎话。
//
//   B. `--porcelain -z` 不展开未跟踪目录，一个新建的目录只回一行
//      `newdir/`。要么展开到文件粒度（-uall），要么面板列的路径根本
//      没法逐个勾选/看 diff。
//
// 这两个都是「检测结果不准」，所以放在一起测。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit, gitStatus } from '../lib/git.js';

/** 造一个空仓库，回调用完删干净。 */
async function withRepo(fn) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-detect-'));
  try {
    const repo = join(base, 'r');
    await runGit(base, ['init', '--quiet', repo]);
    return await fn(repo, base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- A：不许说谎

test('gitStatus 在 git 失败时返回 ok:false，而不是伪装成"没有变更"', async () => {
  const missing = join(tmpdir(), `definitely-not-a-repo-${Date.now()}`);
  const r = await gitStatus(missing);

  assert.equal(r.ok, false, '不存在的目录必须报告失败，不能返回空数组冒充干净');
  assert.ok(typeof r.error === 'string' && r.error.length > 0, '失败要带原因，否则面板没法显示给用户');
  assert.deepEqual(r.changes, [], '失败时 changes 仍是空数组，方便调用方统一处理');
});

test('gitStatus 成功时返回 ok:true 与变更列表', async () => {
  await withRepo(async (repo) => {
    await writeFile(join(repo, 'a.txt'), 'x\n');
    const r = await gitStatus(repo);

    assert.equal(r.ok, true);
    assert.equal(r.error, null);
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0].path, 'a.txt');
    assert.equal(r.changes[0].status, '??');
  });
});

test('干净的仓库是 ok:true + 空列表（这才是"一切都是最新的"）', async () => {
  await withRepo(async (repo) => {
    const r = await gitStatus(repo);
    assert.equal(r.ok, true, '干净仓库是成功，不是失败');
    assert.deepEqual(r.changes, []);
  });
});

// ---------------------------------------------------------------- B：目录要展开

test('未跟踪目录展开到文件粒度，而不是只回一行 "newdir/"', async () => {
  await withRepo(async (repo) => {
    await mkdir(join(repo, 'newdir'));
    await writeFile(join(repo, 'newdir', 'a.txt'), 'x\n');
    await writeFile(join(repo, 'newdir', 'b.txt'), 'y\n');
    await writeFile(join(repo, 'root.txt'), 'z\n');

    const r = await gitStatus(repo);
    const paths = r.changes.map((c) => c.path).sort();

    assert.deepEqual(
      paths,
      ['newdir/a.txt', 'newdir/b.txt', 'root.txt'],
      '面板是按文件勾选和看 diff 的，目录一行会让两个文件绑在一起',
    );
  });
});

test('嵌套多层的新目录同样展开', async () => {
  await withRepo(async (repo) => {
    await mkdir(join(repo, 'a', 'b', 'c'), { recursive: true });
    await writeFile(join(repo, 'a', 'b', 'c', 'deep.txt'), 'x\n');

    const r = await gitStatus(repo);
    assert.deepEqual(r.changes.map((c) => c.path), ['a/b/c/deep.txt']);
  });
});

test('已跟踪文件的修改仍按文件粒度返回', async () => {
  await withRepo(async (repo) => {
    await writeFile(join(repo, 'tracked.txt'), 'v1\n');
    await runGit(repo, ['add', 'tracked.txt']);
    await runGit(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
    await writeFile(join(repo, 'tracked.txt'), 'v2\n');

    const r = await gitStatus(repo);
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0].path, 'tracked.txt');
    assert.equal(r.changes[0].status, 'M');
  });
});
