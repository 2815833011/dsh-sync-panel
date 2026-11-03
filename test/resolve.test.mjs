/**
 * resolve.test.mjs — 三路对比的解析与应用。
 *
 * 先写测试再写实现：冲突处理是这条链上唯一会「吃掉用户内容」的地方，
 * 任何一处猜错都比报错更糟，所以行为必须先钉死。
 *
 * 契约要点（写在这里，避免实现时自行放宽）：
 *   - 标记行必须整行匹配，`=======` 不带标签；正文里出现 `=======` 不会被误判
 *   - CRLF 文件解析后写回仍是 CRLF —— 换个行尾就是全文件 diff
 *   - 有任何 hunk 没给选择就整体失败，绝不默认选某一侧
 *   - 结构不完整的冲突块（缺 `>>>>>>>`）原样保留，不猜
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConflicts, applyChoices, collectConflicts, resolve } from '../lib/conflicts.js';

const DIFF3 = [
  'line before',
  '<<<<<<< HEAD',
  'ours line',
  '||||||| merged common ancestors',
  'base line',
  '=======',
  'theirs line',
  '>>>>>>> origin/main',
  'line after',
].join('\n');

const SIMPLE = ['before', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> other', 'after'].join('\n');

test('parseConflicts 提取 diff3 三段', () => {
  const hunks = parseConflicts(DIFF3);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].ours, 'ours line');
  assert.equal(hunks[0].base, 'base line');
  assert.equal(hunks[0].theirs, 'theirs line');
});

test('parseConflicts 在无祖先段时 base 为空串', () => {
  const hunks = parseConflicts(SIMPLE);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].base, '');
  assert.equal(hunks[0].ours, 'ours');
});

test('parseConflicts 给出稳定 id', () => {
  const a = parseConflicts(DIFF3);
  const b = parseConflicts(DIFF3);
  assert.equal(a[0].id, b[0].id);
});

test('parseConflicts 支持多个冲突块', () => {
  const two = [
    '<<<<<<< HEAD',
    'a1',
    '=======',
    'b1',
    '>>>>>>> x',
    'middle',
    '<<<<<<< HEAD',
    'a2',
    '=======',
    'b2',
    '>>>>>>> x',
  ].join('\n');
  const hunks = parseConflicts(two);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].ours, 'a1');
  assert.equal(hunks[1].ours, 'a2');
});

test('parseConflicts 不会把正文里的 ======= 当成标记', () => {
  const text = ['title', '=======', 'body', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> y'].join('\n');
  const hunks = parseConflicts(text);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].ours, 'ours');
});

test('parseConflicts 忽略不完整的冲突块', () => {
  const broken = ['<<<<<<< HEAD', 'ours', '=======', 'theirs'].join('\n');
  assert.deepEqual(parseConflicts(broken), []);
});

test('parseConflicts 保留 CRLF 文件的 \\r', () => {
  // 用 join('\r\n') 造 CRLF：split('\n') 之后每行末尾自带 \r，不能再手动加
  const crlf = ['before', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> x'].join('\r\n');
  const hunks = parseConflicts(crlf);
  assert.equal(hunks.length, 1, 'CRLF 文件也应能解析');
  assert.equal(hunks[0].ours, 'ours');
  assert.equal(hunks[0].theirs, 'theirs');
});

test('applyChoices 选 ours 后只剩 ours', () => {
  const hunks = parseConflicts(DIFF3);
  const out = applyChoices(DIFF3, hunks, [{ hunkId: hunks[0].id, pick: 'ours' }]);
  assert.ok(out.includes('ours line'));
  assert.ok(!out.includes('theirs line'));
  assert.ok(!out.includes('base line'), '祖先段也要一起清掉');
  assert.ok(!out.includes('<<<<<<<'));
  assert.ok(!out.includes('>>>>>>>'));
  assert.ok(!out.includes('|||||||'));
  assert.ok(out.includes('line before'));
  assert.ok(out.includes('line after'));
});

test('applyChoices 选 theirs 时取下半段', () => {
  const hunks = parseConflicts(DIFF3);
  const out = applyChoices(DIFF3, hunks, [{ hunkId: hunks[0].id, pick: 'theirs' }]);
  assert.ok(out.includes('theirs line'));
  assert.ok(!out.includes('ours line'));
  assert.ok(!out.includes('<<<<<<<'));
});

test('applyChoices 处理多块且顺序正确', () => {
  const two = ['<<<<<<< HEAD', 'a1', '=======', 'b1', '>>>>>>> x', 'mid', '<<<<<<< HEAD', 'a2', '=======', 'b2', '>>>>>>> x'].join('\n');
  const hunks = parseConflicts(two);
  const out = applyChoices(two, hunks, [
    { hunkId: hunks[0].id, pick: 'theirs' },
    { hunkId: hunks[1].id, pick: 'ours' },
  ]);
  assert.equal(out, ['b1', 'mid', 'a2'].join('\n'));
});

test('applyChoices 缺一个选择就整体失败', () => {
  const two = ['<<<<<<< HEAD', 'a1', '=======', 'b1', '>>>>>>> x', 'mid', '<<<<<<< HEAD', 'a2', '=======', 'b2', '>>>>>>> x'].join('\n');
  const hunks = parseConflicts(two);
  assert.throws(
    () => applyChoices(two, hunks, [{ hunkId: hunks[0].id, pick: 'ours' }]),
    /未选择/,
    '漏选必须报错，不能默认选某一侧',
  );
});

test('applyChoices 遇到未知 hunkId 报错', () => {
  const hunks = parseConflicts(SIMPLE);
  assert.throws(() => applyChoices(SIMPLE, hunks, [{ hunkId: hunks[0].id, pick: 'ours' }, { hunkId: 'nope', pick: 'ours' }]), /未知冲突块/);
});

test('applyChoices 非法 pick 报错', () => {
  const hunks = parseConflicts(SIMPLE);
  assert.throws(() => applyChoices(SIMPLE, hunks, [{ hunkId: hunks[0].id, pick: 'both' }]), /pick/);
});

test('applyChoices 保留 CRLF 行尾', () => {
  const crlf = ['before', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> x', 'after'].join('\r\n');
  const hunks = parseConflicts(crlf);
  const out = applyChoices(crlf, hunks, [{ hunkId: hunks[0].id, pick: 'ours' }]);
  assert.ok(out.includes('\r\n'), '写回必须还是 CRLF');
  assert.equal(out.split('\r\n').length, ['before', 'ours', 'after'].length);
});

// ---------------------------------------------------------------------------
// 与 git 的协作：探测冲突时不许在工作区留下标记
// ---------------------------------------------------------------------------

/** 造一个假 git，按顺序回答调用。 */
function makeGit(responses) {
  const calls = [];
  return {
    calls,
    async runGit(cwd, args) {
      calls.push(args);
      const index = calls.length - 1;
      const answer = responses[index];
      if (answer === undefined) return { code: 1, stdout: '', stderr: `unexpected call: ${args.join(' ')}` };
      return { code: 0, stdout: '', stderr: '', ...answer };
    },
  };
}

async function tempRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'dsp-resolve-'));
  await mkdir(join(dir, 'sub'), { recursive: true });
  return dir;
}

test('collectConflicts 探测后一定 abort', async () => {
  const dir = await tempRepo();
  const file = join(dir, 'a.md');
  await writeFile(file, DIFF3, 'utf8');

  const git = makeGit([
    { code: 1, stderr: 'CONFLICT (content): Merge conflict in a.md' }, // merge --no-commit
    { stdout: 'a.md' }, // diff --name-only --diff-filter=U
    { stdout: '' }, // merge --abort
  ]);

  const result = await collectConflicts({ cwd: dir, git });
  await rm(dir, { recursive: true, force: true });

  assert.equal(result.ok, true);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, 'a.md');
  assert.equal(result.files[0].hunks.length, 1);
  assert.equal(result.files[0].hunks[0].ours, 'ours line');
  const aborted = git.calls.some((args) => args[0] === 'merge' && args.includes('--abort'));
  assert.ok(aborted, '探测后必须 abort，否则工作区会留下冲突标记');
});

test('collectConflicts 用 diff3 拿祖先段', async () => {
  const dir = await tempRepo();
  await writeFile(join(dir, 'a.md'), DIFF3, 'utf8');
  const git = makeGit([{ code: 1 }, { stdout: 'a.md' }, {}]);
  await collectConflicts({ cwd: dir, git });
  await rm(dir, { recursive: true, force: true });
  // git -c <key>=<value> merge ... —— -c 必须在子命令之前
  const merge = git.calls.find((args) => args.includes('merge'));
  assert.ok(merge, '没有调用 merge');
  assert.ok(merge.includes('merge.conflictStyle=diff3'), `缺少 diff3：${merge.join(' ')}`);});

test('collectConflicts 无冲突时不动工作区', async () => {
  const dir = await tempRepo();
  const git = makeGit([{ code: 0 }, { stdout: '' }]);
  const result = await collectConflicts({ cwd: dir, git });
  await rm(dir, { recursive: true, force: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.files, []);
  assert.ok(!git.calls.some((args) => args.includes('--abort')), '没冲突就不该 abort');
});

test('resolve 应用选择后 add 并 commit', async () => {
  const dir = await tempRepo();
  const file = join(dir, 'a.md');
  await writeFile(file, DIFF3, 'utf8');
  const hunks = parseConflicts(DIFF3);

  const git = makeGit([
    { code: 1 }, // merge
    { stdout: 'a.md' }, // diff U
    {}, // add
    {}, // commit
  ]);
  const state = { writeLast: async () => {}, appendLog: async () => {} };

  const result = await resolve({
    cwd: dir,
    choices: [{ path: 'a.md', hunkId: hunks[0].id, pick: 'theirs' }],
    git,
    state,
  });

  const written = await readFile(file, 'utf8');
  await rm(dir, { recursive: true, force: true });

  assert.equal(result.ok, true);
  assert.ok(written.includes('theirs line'));
  assert.ok(!written.includes('<<<<<<<'));
  assert.ok(git.calls.some((args) => args[0] === 'add'));
  assert.ok(git.calls.some((args) => args[0] === 'commit'));
});

test('resolve 缺选择时不动文件也不提交', async () => {
  const dir = await tempRepo();
  const file = join(dir, 'a.md');
  await writeFile(file, DIFF3, 'utf8');

  const git = makeGit([{ code: 1 }, { stdout: 'a.md' }, {}]);
  const state = { writeLast: async () => {}, appendLog: async () => {} };

  const result = await resolve({ cwd: dir, choices: [], git, state });
  const untouched = await readFile(file, 'utf8');
  await rm(dir, { recursive: true, force: true });

  assert.equal(result.ok, false);
  assert.match(result.error, /未选择|未提供/);
  assert.equal(untouched, DIFF3, '失败时必须原样保留，交还用户处理');
  assert.ok(!git.calls.some((args) => args[0] === 'commit'), '失败不许提交');
});

test('resolve 在 add 之后 commit 失败会保留暂存但不谎报成功', async () => {
  const dir = await tempRepo();
  await writeFile(join(dir, 'a.md'), DIFF3, 'utf8');
  const hunks = parseConflicts(DIFF3);
  const git = makeGit([{ code: 1 }, { stdout: 'a.md' }, {}, { code: 1, stderr: 'commit failed' }]);
  const state = { writeLast: async () => {}, appendLog: async () => {} };

  const result = await resolve({
    cwd: dir,
    choices: [{ path: 'a.md', hunkId: hunks[0].id, pick: 'ours' }],
    git,
    state,
  });
  await rm(dir, { recursive: true, force: true });

  assert.equal(result.ok, false);
  assert.match(result.error, /commit/);
});

test('resolve 拒绝越界路径', async () => {
  const dir = await tempRepo();
  const git = makeGit([]);
  const state = { writeLast: async () => {}, appendLog: async () => {} };
  const result = await resolve({
    cwd: dir,
    choices: [{ path: '../../etc/passwd', hunkId: 'x', pick: 'ours' }],
    git,
    state,
  });
  await rm(dir, { recursive: true, force: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /越界/);
});
