// test/state.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 用临时目录隔离 STATE_DIR，避免污染真实的 ~/.dsh/dsh-sync
const sandbox = await mkdtemp(join(tmpdir(), 'dsh-sync-state-'));
process.env.DSH_SYNC_STATE_DIR = sandbox;
after(() => rm(sandbox, { recursive: true, force: true }));

const { readSelection, writeSelection, readLast, writeLast, appendLog, STATE_DIR } =
  await import('../lib/state.js');

test('STATE_DIR 尊重环境变量覆盖', () => {
  assert.equal(STATE_DIR, sandbox);
});

test('readSelection 在文件不存在时返回空对象', async () => {
  assert.deepEqual(await readSelection(), {});
});

test('writeSelection 后能读回相同内容', async () => {
  await writeSelection({ 'AGENTS.md': true, 'skills/': false });
  assert.deepEqual(await readSelection(), { 'AGENTS.md': true, 'skills/': false });
});

test('readLast 在文件不存在时返回 null', async () => {
  assert.equal(await readLast(), null);
});

test('writeLast 后能读回相同内容', async () => {
  const record = { sha: 'abc1234', subject: 'sync: 2026-10-29T10:00:00.000Z', at: '2026-10-29T10:00:00.000Z' };
  await writeLast(record);
  assert.deepEqual(await readLast(), record);
});

test('appendLog 逐行累积', async () => {
  await appendLog('第一行');
  await appendLog('第二行');
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(join(sandbox, 'log.txt'), 'utf8');
  assert.ok(text.includes('第一行'));
  assert.ok(text.includes('第二行'));
  assert.ok(text.split('\n').filter(Boolean).length >= 2);
});

test('写坏的 JSON 时读取返回默认值而不抛', async () => {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(sandbox, 'selection.json'), '{ 这不是 JSON', 'utf8');
  assert.deepEqual(await readSelection(), {});
});

// ---------------------------------------------------------------------------
// 仓库目录记忆
// ---------------------------------------------------------------------------
//
// 存在这一层而不是只靠浏览器 localStorage，是因为 DSH 每次重启 web 端口
// 都会变（1317 → 4718 → 8591），而 localStorage 按 origin 隔离。只记在
// 前端 = 每次重启都让用户重填一遍仓库路径。

test('readRepo 没存过时返回空串而不是 undefined', async () => {
  const { readRepo } = await import('../lib/state.js');
  assert.equal(await readRepo(), '', '首次运行要能安全地拿到一个假值');
});

test('仓库路径能原样存取（中文与空格不能被改动）', async () => {
  const { readRepo, writeRepo } = await import('../lib/state.js');
  const repo = 'E:/工作空间/DSH 工作台改造/dsh-sync';
  await writeRepo(repo);
  assert.equal(await readRepo(), repo);
});

test('repo.json 坏掉时返回空串，不让面板启动就崩', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { readRepo } = await import('../lib/state.js');
  await writeFile(join(sandbox, 'repo.json'), '{ 这不是 JSON', 'utf8');
  assert.equal(await readRepo(), '');
});

test('repo.json 里 cwd 不是字符串时也返回空串', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { readRepo } = await import('../lib/state.js');
  await writeFile(join(sandbox, 'repo.json'), JSON.stringify({ cwd: 42 }), 'utf8');
  assert.equal(await readRepo(), '');
});
