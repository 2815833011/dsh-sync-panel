/**
 * lib/ops.js — 三条操作链：推送 / 拉取 / 回滚。
 *
 * 每个函数都不抛异常，一律返回 { ok, ... }。
 * 每一步都按「上一成功才继续」推进：git 的退出码是唯一裁决者，
 * 不靠 stderr 里有没有某个词来猜。
 *
 * 依赖注入（git / state）只为了可测；生产调用点见 index.js。
 */

import { isInsideRepo } from './paths.js';
import { runGit as defaultRunGit } from './git.js';

/**
 * 默认的日志行格式：[动作] 结果
 * @param {string} action
 * @param {string} detail
 */
function stamp(action, detail) {
  return `${action} ${detail}`;
}

/**
 * 失败结果的统一形状。
 * @param {string} error
 * @param {Record<string, unknown>} [extra]
 */
function fail(error, extra = {}) {
  return { ok: false, error, ...extra };
}

/**
 * 推送：筛选路径 → add → 查暂存区有无变更 → commit → push。
 *
 * 关键设计：`commit` 之前先看 `diff --cached --name-only`，
 * 无输出就直接返回（committed: 0）。不靠解析 "nothing to commit" 文案。
 *
 * @param {object} opts
 * @param {string} opts.cwd - 仓库目录。
 * @param {string[]} opts.paths - 前端勾选的路径（不可信，必须校验）。
 * @param {string} [opts.message] - 提交信息。
 * @param {{ runGit: Function }} opts.git - git 执行器。
 * @param {{ writeLast: Function, appendLog: Function }} opts.state - 状态写入器。
 */
/**
 * 确保当前分支有 upstream，返回 branch 名；失败返回 null。
 *
 * 新克隆的仓库、或 `git init` 之后第一次推，`main` 往往没有 tracking
 * 分支。这时候裸 `git push` 会失败，但**提交已经发生**——于是仓库卡在
 * 「本地有提交、远端没有」的半成功状态。用户下次点推送看到「没有改动」，
 * 以为推上去了，实际远端一条都没有。所以在 push 之前先把 upstream 备好。
 *
 * @param {string} cwd
 * @param {{ runGit: Function }} git
 * @returns {Promise<string|null>}
 */
async function ensureUpstream(cwd, git) {
  const upstream = await git.runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstream.code === 0) return null; // 已经有了，不需要动

  const branch = await git.runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return branch.code === 0 && branch.stdout.trim() ? branch.stdout.trim() : null;
}

/**
 * 判断是否存在「已提交但没推上去」的提交。
 *
 * 上一个 `push` 可能提交成功、推送失败（没 upstream、断网、凭据过期）。
 * 那种仓库工作区是干净的，只看暂存区会误判成「无事可做」，于是那条
 * 提交永远推不上去。这里用 HEAD 与远端跟踪分支的差异来判断。
 *
 * 远端不可达时返回 false —— 宁可报「没有改动」，也不要在网络故障时
 * 把每个文件都当成待推。
 *
 * @param {string} cwd
 * @param {{ runGit: Function }} git
 * @returns {Promise<boolean>}
 */
async function hasUnpushedCommits(cwd, git) {
  const up = await git.runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (up.code !== 0) {
    // 没有 upstream：看远端有没有同名分支。有就往回追，没有就是全新分支。
    const branch = await git.runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch.code !== 0 || !branch.stdout.trim()) return false;
    const remoteRef = `origin/${branch.stdout.trim()}`;
    const exists = await git.runGit(cwd, ['rev-parse', '--verify', '--quiet', remoteRef]);
    if (exists.code !== 0) return true; // 远端没有这个分支，手上的一切都还没推
    const ahead = await git.runGit(cwd, ['rev-list', '--count', `${remoteRef}..HEAD`]);
    if (ahead.code !== 0) return false;
    return Number(ahead.stdout.trim() || '0') > 0;
  }

  const ahead = await git.runGit(cwd, ['rev-list', '--count', '@{u}..HEAD']);
  if (ahead.code !== 0) return false;
  return Number(ahead.stdout.trim() || '0') > 0;
}

/**
 * 找出「与之比较」的远端引用：优先 upstream，其次 origin/<当前分支>。
 *
 * 没有 upstream 时不能退回 `origin/HEAD` —— 那指向默认分支，跟当前分支
 * 未必有共同历史，算出来的差值没有意义。拿不到就返回 null，调用方按
 * 「无从比较」处理。
 *
 * 只读本地引用，不联网。
 *
 * @param {string} cwd
 * @param {{ runGit: Function }} g
 * @returns {Promise<string|null>}
 */
async function resolveBaseRef(cwd, g) {
  const up = await g.runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (up.code === 0 && up.stdout.trim()) return '@{u}';

  const branch = await g.runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.code !== 0 || !branch.stdout.trim()) return null;
  const remoteRef = `origin/${branch.stdout.trim()}`;
  const exists = await g.runGit(cwd, ['rev-parse', '--verify', '--quiet', remoteRef]);
  return exists.code === 0 ? remoteRef : null;
}

/**
 * 计算「已提交但没推上去」的提交数，供面板决定推送按钮是否可点。
 *
 * 只读，不改仓库。远端信息拿不到时返回 0 —— 面板宁可少亮一个按钮，
 * 也不要在网络故障时谎报有待推内容。
 *
 * @param {string} cwd
 * @param {{ runGit: Function }} [gitImpl]
 * @returns {Promise<number>}
 */
export async function countAhead(cwd, gitImpl) {
  const g = gitImpl ?? { runGit: defaultRunGit };
  try {
    const base = await resolveBaseRef(cwd, g);
    if (!base) {
      // 没有可比对的远端引用：要么全新仓库，要么远端没这个分支。
      // 只要本地有提交，就都还没推上去。
      const head = await g.runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
      return head.code === 0 ? 1 : 0;
    }
    const n = await g.runGit(cwd, ['rev-list', '--count', `${base}..HEAD`]);
    if (n.code !== 0) return 0;
    return Number(n.stdout.trim() || '0');
  } catch {
    return 0;
  }
}

/**
 * 计算「远端有、本地还没有」的提交数，供主按钮判断该提示拉取。
 *
 * 故意不跑 `git fetch`：status 每次刷新都调用它，联网会让面板卡住几秒，
 * 断网时更是直接发呆。这里读的是上一次 fetch 留下的本地引用，因此数值
 * 反映「你上次联网之后远端多了几个提交」，足以驱动「该拉一下了」的提示。
 *
 * @param {string} cwd
 * @param {{ runGit: Function }} [gitImpl]
 * @returns {Promise<number>}
 */
export async function countBehind(cwd, gitImpl) {
  const g = gitImpl ?? { runGit: defaultRunGit };
  try {
    const base = await resolveBaseRef(cwd, g);
    if (!base) return 0;
    const n = await g.runGit(cwd, ['rev-list', '--count', `HEAD..${base}`]);
    if (n.code !== 0) return 0;
    return Number(n.stdout.trim() || '0');
  } catch {
    return 0;
  }
}

export async function push({ cwd, paths, message, git, state }) {
  const raw = Array.isArray(paths) ? paths : [];
  const safe = raw.filter((p) => isInsideRepo(cwd, p));

  let staged = { code: 0, stdout: '' };

  if (safe.length > 0) {
    const added = await git.runGit(cwd, ['add', '--', ...safe]);
    if (added.code !== 0) {
      await state.appendLog(stamp('push', `add 失败 ${added.stderr}`));
      return fail(added.stderr || 'git add 失败');
    }

    staged = await git.runGit(cwd, ['diff', '--cached', '--name-only']);
    if (staged.code !== 0) {
      return fail(staged.stderr || '无法读取暂存区');
    }
  } else if (!(await hasUnpushedCommits(cwd, git))) {
    // 一个合法路径都没有，而且也没有欠推的提交 —— 这才是真的无事可做。
    // 若存在欠推的提交，放行去推：那是上一次「提交成功、推送失败」的残留。
    await state.appendLog(stamp('push', '拒绝：没有合法路径'));
    return fail('没有可推送的合法路径');
  }

  const commitMsg = message || `sync: ${new Date().toISOString()}`;
  let committedCount = 0;

  if (staged.stdout.trim()) {
    const committed = await git.runGit(cwd, ['commit', '-m', commitMsg]);
    if (committed.code !== 0) {
      // 提交没成功，把暂存区还原，别把仓库留在"已暂存待提交"的状态
      await git.runGit(cwd, ['reset', '--quiet']);
      await state.appendLog(stamp('push', `commit 失败 ${committed.stderr}`));
      return fail(committed.stderr || 'git commit 失败');
    }
    committedCount = 1;
  } else {
    // 没有要提交的改动。但这不代表没事可做——上一次可能「提交成功、
    // 推送失败」，那时工作区是干净的，如果这里直接返回「没有改动」，
    // 那条提交就永远推不上去了，用户点一百次也还是这句话。
    if (!(await hasUnpushedCommits(cwd, git))) {
      await state.appendLog(stamp('push', '无改动'));
      return { ok: true, committed: 0, message: '没有需要提交的改动' };
    }
  }

  // 先确认有 upstream：没有的话 push 会失败而提交已经落地，
  // 那是「半成功」，比直接失败更难察觉。
  const branch = await ensureUpstream(cwd, git);
  const pushArgs = branch === null ? ['push'] : ['push', '--set-upstream', 'origin', branch];
  const pushed = await git.runGit(cwd, pushArgs);
  if (pushed.code !== 0) {
    // 提交已经发生，必须告诉调用方「本地成功、远端失败」，
    // 不能报成普通失败让人以为什么都没做。
    const sha = await git.runGit(cwd, ['rev-parse', '--short', 'HEAD']);
    const shortSha = sha.code === 0 ? sha.stdout.trim() : '';
    await state.writeLast({
      sha: shortSha,
      subject: commitMsg,
      at: new Date().toISOString(),
      action: 'push',
      cwd,
      localOnly: true,
    });
    await state.appendLog(stamp('push', `已提交未推送 ${shortSha} ${pushed.stderr}`));
    return {
      ...fail(pushed.stderr || 'git push 失败', { committed: committedCount }),
      ok: false,
      committed: committedCount,
      sha: shortSha,
      localOnly: true,
      message: '已在本地提交，但没有推送到远端',
    };
  }

  const sha = await git.runGit(cwd, ['rev-parse', '--short', 'HEAD']);
  const record = {
    sha: sha.code === 0 ? sha.stdout.trim() : '',
    subject: commitMsg,
    at: new Date().toISOString(),
    action: 'push',
    cwd,
  };
  await state.writeLast(record);
  await state.appendLog(stamp('push', `ok ${record.sha}`));

  return {
    ok: true,
    committed: committedCount,
    sha: record.sha,
    message:
      committedCount === 1 ? commitMsg : '没有新改动，已把之前欠推的提交推上去',
  };
}

/**
 * 拉取：fetch → merge → （冲突则收集冲突文件并 abort）。
 *
 * 冲突处理用 `--no-commit --no-ff` 的 merge 是为了在 abort 前
 * 能读到冲突清单；读完立刻回滚，工作区恢复成拉取前的样子，
 * 由前端拿 conflicts 去走三路对比。
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {{ runGit: Function }} opts.git
 * @param {{ writeLast: Function, appendLog: Function }} opts.state
 */
export async function pull({ cwd, git, state }) {
  const fetched = await git.runGit(cwd, ['fetch', '--all', '--prune']);
  if (fetched.code !== 0) {
    await state.appendLog(stamp('pull', `fetch 失败 ${fetched.stderr}`));
    return fail(fetched.stderr || 'git fetch 失败');
  }

  const merged = await git.runGit(cwd, ['merge', '--no-edit', '--no-ff', '@{u}']);
  if (merged.code !== 0) {
    const status = await git.runGit(cwd, ['diff', '--name-only', '--diff-filter=U']);
    const conflicts =
      status.code === 0 ? status.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];

    await git.runGit(cwd, ['merge', '--abort']);
    await state.appendLog(stamp('pull', `冲突 ${conflicts.length} 个`));
    return fail(merged.stderr || '合并失败', { conflicts });
  }

  const record = {
    sha: '',
    subject: 'pull',
    at: new Date().toISOString(),
    action: 'pull',
    cwd,
  };
  await state.writeLast(record);
  await state.appendLog(stamp('pull', 'ok'));

  return { ok: true, conflicts: [], message: merged.stdout || '已是最新' };
}

/**
 * 回滚：把一个目标提交反向应用（git revert），再推上去。
 *
 * revert 而不是 reset —— 已推送过的历史不能改写，否则家里和公司
 * 两台机器会各自持有不同的历史，下次同步就成了灾难。
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.target - 要回滚掉的提交（通常是上次 push 的 sha）。
 * @param {{ runGit: Function }} opts.git
 * @param {{ writeLast: Function, appendLog: Function }} opts.state
 */
export async function rollback({ cwd, target, git, state }) {
  if (!target || typeof target !== 'string') {
    return fail('缺少回滚目标');
  }

  const verified = await git.runGit(cwd, ['rev-parse', '--verify', '--quiet', target]);
  if (verified.code !== 0) {
    await state.appendLog(stamp('rollback', `目标不存在 ${target}`));
    return fail(`目标提交不存在：${target}`);
  }

  const reverted = await git.runGit(cwd, ['revert', '--no-edit', target]);
  if (reverted.code !== 0) {
    await git.runGit(cwd, ['revert', '--abort']);
    await state.appendLog(stamp('rollback', `revert 失败 ${reverted.stderr}`));
    return fail(reverted.stderr || 'git revert 失败');
  }

  // 和 push 一样：没有 upstream 时裸 push 会失败，而 revert 提交已经落地。
  const branch = await ensureUpstream(cwd, git);
  const pushed = await git.runGit(
    cwd,
    branch === null ? ['push'] : ['push', '--set-upstream', 'origin', branch],
  );
  if (pushed.code !== 0) {
    await state.appendLog(stamp('rollback', `已回滚未推送 ${target} ${pushed.stderr}`));
    return {
      ...fail(pushed.stderr || 'git push 失败'),
      ok: false,
      localOnly: true,
      message: '已在本地回滚，但没有推送到远端',
    };
  }

  const record = {
    sha: verified.stdout.trim(),
    subject: `revert ${target}`,
    at: new Date().toISOString(),
    action: 'rollback',
    cwd,
  };
  await state.writeLast(record);
  await state.appendLog(stamp('rollback', `ok ${target}`));

  return { ok: true, message: `已回滚 ${target}` };
}

/**
 * 最近提交列表，供面板「回滚到哪个」使用。
 *
 * 用 \u001f 分隔字段而不是空格 —— 提交标题里可能有空格和中文，
 * 空格分割会在第一次遇到就切错。
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {number} [opts.count]
 * @param {{ runGit: Function }} opts.git
 * @returns {Promise<Array<{ sha: string, subject: string, at: string }>>}
 */
export async function listRecent({ cwd, count = 20, git }) {
  const r = await git.runGit(cwd, [
    'log',
    `-${count}`,
    '--pretty=format:%h\u001f%s\u001f%aI',
  ]);
  if (r.code !== 0) return [];

  return r.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, at] = line.split('\u001f');
      return { sha: sha ?? '', subject: subject ?? '', at: at ?? '' };
    });
}
