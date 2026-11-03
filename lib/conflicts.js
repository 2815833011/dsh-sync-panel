/**
 * lib/conflicts.js — 三路对比：读冲突、让人逐块选、写回。
 *
 * 从 ops.js 分出来是因为这块逻辑最长、最容易出错，而它的失败方式和其他
 * 操作不同：其他操作失败是「没做成」，这里失败是「悄悄写坏用户的文件」。
 * 单独一个文件方便逐条对照测试。
 *
 * 两条铁律：
 *   1. 有任何一块没拿到选择，一个字节都不写。
 *   2. 放弃时（任何一步失败）调用方可以安全 abort，工作区回到合并前。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isInsideRepo } from './paths.js';

/**
 * 失败结果的统一形状。
 * @param {string} error
 * @param {Record<string, unknown>} [extra]
 */
function fail(error, extra = {}) {
  return { ok: false, error, ...extra };
}

/**
 * 把一段可选的祖先标记剥掉行尾的回车。
 * @param {string} line
 * @returns {string}
 */
function bare(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** 标记行整行匹配。`=======` 没有标签，所以不能拿 startsWith 粗判正文。 */
const OPEN = /^<{7}(\s|$)/;
const BASE = /^\|{7}(\s|$)/;
const MID = /^={7}$/;
const CLOSE = /^>{7}(\s|$)/;

/**
 * 一个冲突块的稳定 id。
 *
 * 用「起始行号 + 该文件里第几个块」而不是随机值或内容 hash：行号在同一次
 * 解析里唯一且可复现，重新打开面板还能对上；内容 hash 在两侧巧合相同时会撞。
 *
 * @param {number} line - 起始行号（0 基）。
 * @param {number} index - 该文件里第几个冲突块（0 基）。
 * @returns {string}
 */
function makeId(line, index) {
  return `h${String(line)}-${String(index)}`;
}

/**
 * 把带冲突标记的文本切成块。
 *
 * 只认完整结构（必须有 `<<<<<<<`、`=======`、`>>>>>>>`）。缺闭合标记的块
 * 整段跳过 —— 返回空数组会让上游报「没有可解析的冲突」，而不是拿半截内容
 * 去覆盖用户文件。
 *
 * @param {string} text
 * @returns {Array<{
 *   id: string, start: number, end: number, midAt: number, baseAt: number,
 *   ours: string, base: string, theirs: string, index: number
 * }>}
 */
export function parseConflicts(text) {
  const lines = String(text ?? '').split('\n');
  const hunks = [];
  let start = -1;
  let baseAt = -1;
  let midAt = -1;
  let index = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = bare(lines[i]);

    if (start === -1) {
      if (OPEN.test(line)) {
        start = i;
        baseAt = -1;
        midAt = -1;
      }
      continue;
    }

    if (midAt === -1 && baseAt === -1 && BASE.test(line)) {
      baseAt = i;
      continue;
    }

    if (midAt === -1 && MID.test(line)) {
      midAt = i;
      continue;
    }

    if (CLOSE.test(line)) {
      if (midAt !== -1) {
        /** 把一段原始行去掉行尾 \r 后拼成语义内容。 */
        const slice = (from, to) => lines.slice(from, to).map(bare).join('\n');
        hunks.push({
          id: makeId(start, index),
          start,
          end: i,
          midAt,
          baseAt,
          ours: slice(start + 1, baseAt === -1 ? midAt : baseAt),
          base: baseAt === -1 ? '' : slice(baseAt + 1, midAt),
          theirs: slice(midAt + 1, i),
          index,
        });
        index += 1;
      }
      start = -1;
      baseAt = -1;
      midAt = -1;
    }
  }

  return hunks;
}

/**
 * 按每个块的选择重写整篇文本。
 *
 * - 从后往前替换，前面的行号不会因为替换而偏移。
 * - 行尾由原文件决定：CRLF 文件的每一行本来就带 `\r`，拼接后自然还是 CRLF。
 *   换个行尾就是「全文件都改了」，那是最难查的 diff。
 * - 漏选、未知块、非法 pick 一律抛错，绝不默认选某一侧。
 *
 * @param {string} text
 * @param {ReturnType<typeof parseConflicts>} hunks
 * @param {Array<{ hunkId: string, pick: 'ours'|'theirs' }>} choices
 * @returns {string}
 */
export function applyChoices(text, hunks, choices) {
  const chosen = new Map();
  for (const choice of choices ?? []) {
    if (choice?.pick !== 'ours' && choice?.pick !== 'theirs') {
      throw new Error(`非法 pick：${String(choice?.pick)}（只能是 ours 或 theirs）`);
    }
    chosen.set(choice.hunkId, choice.pick);
  }

  for (const id of chosen.keys()) {
    if (!hunks.some((hunk) => hunk.id === id)) throw new Error(`未知冲突块：${String(id)}`);
  }

  for (const hunk of hunks) {
    if (!chosen.has(hunk.id)) throw new Error(`冲突块 ${hunk.id} 未选择，拒绝写出半成品`);
  }

  const lines = [...String(text ?? '').split('\n')];
  const ordered = [...hunks].sort((a, b) => b.start - a.start);

  for (const hunk of ordered) {
    const pick = chosen.get(hunk.id);
    // ours 段止于祖先段（有 diff3 时）或分隔符；theirs 段是分隔符之后到闭合标记之前。
    const body = pick === 'ours'
      ? lines.slice(hunk.start + 1, hunk.baseAt === -1 ? hunk.midAt : hunk.baseAt)
      : lines.slice(hunk.midAt + 1, hunk.end);
    lines.splice(hunk.start, hunk.end - hunk.start + 1, ...body);
  }

  return lines.join('\n');
}

/**
 * 试合并一次，把工作区带到「冲突已发生、尚未提交」的状态，并读出冲突块。
 *
 * 注意这里 **没有** abort：调用方要么接着写回并提交，要么自己调 abort。
 * 分开是因为两条路径对工作区的要求相反 —— 探测完就 abort 会让用户的选择
 * 无处可写，而写完再 abort 会把刚写好的内容扔掉。
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {{ runGit: Function }} opts.git
 * @returns {Promise<{ ok: boolean, clean: boolean, paths: string[], files: Array<{ path: string, hunks: Array<object> }>, error?: string }>}
 */
export async function probeMerge({ cwd, git }) {
  // -c merge.conflictStyle=diff3 必须在子命令之前，否则 git 会当成路径
  const merged = await git.runGit(cwd, ['-c', 'merge.conflictStyle=diff3', 'merge', '--no-edit', '--no-ff', '@{u}']);
  if (merged.code === 0) {
    return { ok: true, clean: true, paths: [], files: [] };
  }

  const listed = await git.runGit(cwd, ['diff', '--name-only', '--diff-filter=U']);
  if (listed.code !== 0) {
    await git.runGit(cwd, ['merge', '--abort']);
    return { ok: false, clean: false, paths: [], files: [], error: listed.stderr || '无法读取冲突清单' };
  }

  const paths = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  if (paths.length === 0) {
    await git.runGit(cwd, ['merge', '--abort']);
    return { ok: false, clean: false, paths: [], files: [], error: merged.stderr || '合并失败但没有冲突文件' };
  }

  const files = [];
  for (const path of paths) {
    if (!isInsideRepo(cwd, path)) continue;
    try {
      const text = await readFile(join(cwd, path), 'utf8');
      files.push({ path, hunks: parseConflicts(text) });
    } catch {
      files.push({ path, hunks: [] });
    }
  }

  return { ok: true, clean: false, paths, files };
}

/**
 * 读一次冲突全貌，读完立刻 abort，让工作区回到干净状态。
 *
 * 面板用它显示「有哪几个文件冲突、每块两侧各是什么」，用户此时只是看。
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {{ runGit: Function }} opts.git
 * @returns {Promise<{ ok: boolean, files: Array<{ path: string, hunks: Array<object> }>, error?: string }>}
 */
export async function collectConflicts({ cwd, git }) {
  const probed = await probeMerge({ cwd, git });
  if (probed.clean) return { ok: true, files: [] };
  // 无论成败都 abort：这一步只负责「看一眼」
  if (!probed.clean && probed.paths.length > 0) await git.runGit(cwd, ['merge', '--abort']);
  if (!probed.ok) return { ok: false, files: [], error: probed.error };
  return { ok: true, files: probed.files };
}

/**
 * 应用用户的选择并完成合并提交。
 *
 * 顺序刻意如此：先把所有文件的新内容算出来放在内存里，全部通过后才落盘。
 * 中途发现某个文件缺选择时，磁盘上还是原样 —— 用户可以接着选。
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {Array<{ path: string, hunkId: string, pick: 'ours'|'theirs' }>} opts.choices
 * @param {{ runGit: Function }} opts.git
 * @param {{ writeLast: Function, appendLog: Function }} opts.state
 * @returns {Promise<{ ok: boolean, sha?: string, files?: string[], error?: string }>}
 */
export async function resolve({ cwd, choices, git, state }) {
  if (!Array.isArray(choices) || choices.length === 0) {
    return fail('未提供任何冲突选择');
  }
  for (const choice of choices) {
    if (typeof choice?.path !== 'string' || choice.path === '') return fail('选择缺少文件路径');
    if (!isInsideRepo(cwd, choice.path)) return fail(`路径越界：${choice.path}`);
  }

  const probed = await probeMerge({ cwd, git });
  if (!probed.ok) return fail(probed.error ?? '合并失败');
  if (probed.clean) return fail('没有冲突需要处理（可能已经合并过了）');

  /** 先在内存里把所有文件的新内容算出来，一个都不写。 */
  const pending = [];
  for (const file of probed.files) {
    if (file.hunks.length === 0) {
      await git.runGit(cwd, ['merge', '--abort']);
      return fail(`文件 ${file.path} 的冲突标记不完整，无法自动处理`);
    }
    const mine = choices.filter((choice) => choice.path === file.path);
    const missing = file.hunks.filter((hunk) => !mine.some((choice) => choice.hunkId === hunk.id));
    if (missing.length > 0) {
      await git.runGit(cwd, ['merge', '--abort']);
      return fail(`文件 ${file.path} 有 ${String(missing.length)} 处未选择`);
    }
    try {
      const text = await readFile(join(cwd, file.path), 'utf8');
      pending.push({ path: file.path, content: applyChoices(text, file.hunks, mine), before: text });
    } catch (error) {
      await git.runGit(cwd, ['merge', '--abort']);
      return fail(`${file.path}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 落盘；写失败就把已写的还原，不留下半个文件
  const written = [];
  try {
    for (const item of pending) {
      await writeFile(join(cwd, item.path), item.content, 'utf8');
      written.push(item);
    }
  } catch (error) {
    for (const item of written) {
      try {
        await writeFile(join(cwd, item.path), item.before, 'utf8');
      } catch {
        /* 还原也失败时没有更好的补救，把错误报出去让用户处理 */
      }
    }
    await git.runGit(cwd, ['merge', '--abort']);
    return fail(`写文件失败：${error instanceof Error ? error.message : String(error)}`);
  }

  for (const item of pending) {
    const added = await git.runGit(cwd, ['add', '--', item.path]);
    if (added.code !== 0) {
      await git.runGit(cwd, ['merge', '--abort']);
      return fail(`git add 失败：${added.stderr || item.path}`);
    }
  }

  const committed = await git.runGit(cwd, ['commit', '--no-edit']);
  if (committed.code !== 0) {
    await state.appendLog(`resolve commit 失败 ${committed.stderr}`);
    return fail(committed.stderr || 'git commit 失败');
  }

  const sha = await git.runGit(cwd, ['rev-parse', '--short', 'HEAD']);
  const record = {
    sha: sha.code === 0 ? sha.stdout.trim() : '',
    subject: `resolve ${String(pending.length)} files`,
    at: new Date().toISOString(),
    action: 'resolve',
    cwd,
  };
  await state.writeLast(record);
  await state.appendLog(`resolve ok ${record.sha}`);

  return { ok: true, sha: record.sha, files: pending.map((item) => item.path) };
}
