// test/git.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit, gitStatus } from '../lib/git.js';

test('runGit 对不存在的目录返回非零而不是抛异常', async () => {
  const r = await runGit('Z:\\definitely\\not\\here', ['status']);
  assert.notEqual(r.code, 0);
  assert.ok(r.stderr.length > 0);
});

test('runGit 路径含空格与中文时不截断', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh sync 测试 '));
  try {
    const repo = join(base, '我的 仓库');
    await runGit(base, ['init', '--quiet', repo]);
    await writeFile(join(repo, 'a.txt'), 'hi\n');
    const r = await runGit(repo, ['rev-parse', '--show-toplevel']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('我的 仓库'), `期望含中文空格路径，实际: ${r.stdout}`);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('gitStatus 解析 porcelain 输出', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-status-'));
  try {
    const repo = join(base, 'r');
    await runGit(base, ['init', '--quiet', repo]);
    await writeFile(join(repo, 'new.txt'), 'x\n');
    const r = await gitStatus(repo);
    assert.equal(r.ok, true);
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0].path, 'new.txt');
    assert.equal(r.changes[0].status, '??');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('gitStatus 处理文件名含空格', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-status2-'));
  try {
    const repo = join(base, 'r');
    await runGit(base, ['init', '--quiet', repo]);
    await writeFile(join(repo, 'my file.txt'), 'x\n');
    const r = await gitStatus(repo);
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0].path, 'my file.txt');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
