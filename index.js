/**
 * Host half of dsh-sync-panel.
 *
 * The panel's buttons call these loopback-only routes; each route runs the
 * same git work the CLI does, but reports progress as JSON so the panel can
 * render a live log instead of a black box.
 *
 * Every route shares ONE guard: the guard doubles as a mutex, so two clicks
 * (or a click plus a scheduled push) can never drive git at the same time.
 * Concurrent `git add`/`commit` on one index is how a config sync loses the
 * user's work, so a 409 is the correct answer to the second request.
 */

import { runGit as realRunGit, gitStatus, parsePorcelain } from './lib/git.js';
import { push, pull, rollback, listRecent, countAhead, countBehind } from './lib/ops.js';
import { collectConflicts, resolve } from './lib/conflicts.js';
import {
  readSelection, writeSelection, readLast, writeLast, appendLog, readLogTail, readAuto, writeAuto,
  readRepo, writeRepo,
} from './lib/state.js';
import { DEFAULTS, normalize, decide, pollMs, afterRun } from './lib/auto.js';
import { createGuard, sendJson, readJsonBody, MARKER_HEADER } from './lib/routes.js';
import { isInsideRepo } from './lib/paths.js';
import { exportLayer, hasExporter } from './lib/export.js';

export { MARKER_HEADER };

/** 后端能力依赖。 */
export const inject = ['webServer'];

/** 所有路由共用的前缀。 */
const PREFIX = '/dsh-sync-panel';

/**
 * 从请求体里取仓库目录，并确认它真的是一个 git 工作区。
 *
 * 面板只服务自己那个快照仓库，但目录来自前端，所以仍然要校验：
 * 目录不存在、不是 git 仓库、或点在 .git 里面，都直接拒绝。
 *
 * @param {object} body
 * @param {{ runGit: Function }} git
 * @returns {Promise<{ ok: true, cwd: string } | { ok: false, error: string }>}
 */
async function resolveRepo(body, git) {
  const cwd = typeof body?.cwd === 'string' ? body.cwd.trim() : '';
  if (!cwd) return { ok: false, error: '缺少仓库目录' };

  const top = await git.runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) {
    return { ok: false, error: `不是 git 仓库：${cwd}` };
  }
  return { ok: true, cwd: top.stdout.trim() };
}

/**
 * Mount the sync routes.
 * @param {object} ctx - the Host plugin context.
 */
export function apply(ctx) {
  const guard = createGuard();
  const git = { runGit: realRunGit };
  const state = { writeLast, appendLog };

  /**
   * 定时推送的现状。
   *
   * `timerCwd` 不是可有可无的装饰：面板可以换仓库，用户在 A 仓库打开的
   * 自动推送不应该在切到 B 之后继续替 A 提交。所以定时器只认一个目录，
   * 换设置或换仓库都重排。
   */
  let timer = null;
  let timerCwd = '';
  /** 本轮看到的最近一次改动时刻；idle 模式靠它判断「安静够久了吗」。 */
  let lastChangeAt = null;

  /** @returns {string} 当前挂着定时器的仓库目录，没有则空串。 */
  function scheduledCwd() {
    return timerCwd;
  }

  /** 停掉定时器，不再有任何后台动作。 */
  function stopTimer() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    timerCwd = '';
  }

  /**
   * 到点检查一次。
   *
   * 所有副作用都在这里，决策本身留给 auto.decide —— 决策是纯函数，
   * 测试才能覆盖到「有冲突时绝不自动推」这类规则而不必真的起定时器。
   *
   * @param {string} cwd
   * @param {typeof DEFAULTS} settings
   */
  async function tick(cwd) {
    // 拿不到锁说明面板上有人在操作，这一轮直接放弃，下一轮再看。
    if (!guard.tryAcquire()) return;

    try {
      const status = await gitStatus(cwd);
      if (!status.ok) {
        // 检测失败 ≠ 没有改动。当成干净会让自动推送静默停摆：
        // 用户看着「一切都是最新的」，实际上一堆改动没推。
        await appendLog(`auto: 跳过（变更检测失败：${status.error}）`);
        return;
      }
      const changes = status.changes;
      const hasConflicts = changes.some((c) => c.status === 'U');
      const hasChanges = changes.length > 0;

      // 只在「这一刻确实有改动」时更新，否则安静计时会被清理动作重置。
      if (hasChanges) lastChangeAt = Date.now();

      // 以磁盘为准重读：失败计数是上一轮自己写进去的，用闭包里那份旧
      // settings 会让 failures 永远停在进入时的值，自停永远不触发。
      // 设置被关掉时 schedule() 已经把定时器停了，走到这里说明它仍该跑。
      const settings = normalize(await readAuto());
      const lastRunAt = settings.lastRunAt ? Date.parse(settings.lastRunAt) : null;
      const verdict = decide({
        settings,
        now: Date.now(),
        lastChangeAt,
        lastRunAt: Number.isFinite(lastRunAt) ? lastRunAt : null,
        busy: false,
        hasChanges,
        hasConflicts,
      });

      if (!verdict.run) return;

      const selection = await readSelection();
      const picked = changes
        .map((c) => c.path)
        .filter((p) => selection?.[p] === true);

      if (picked.length === 0) {
        // 自动推送只推勾过的；没勾就当用户没答应过，记一笔但不报错。
        await appendLog(`auto: 跳过（没有勾选任何文件）reason=${verdict.reason}`);
        return;
      }

      const result = await push({
        cwd,
        paths: picked,
        message: `自动同步 ${new Date().toLocaleString('zh-CN')}`,
        git,
        state,
      });

      await writeAuto(afterRun(settings, result));
      await appendLog(`auto: ${result.ok ? '推送成功' : `推送失败 ${result.error ?? ''}`} reason=${verdict.reason}`);
    } catch (error) {
      // 后台任务抛出去没有人接，只会变成 unhandledRejection 打断宿主。
      ctx.logger?.warn?.(`dsh-sync-panel: auto push failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      guard.release();
    }
  }

  /**
   * 按设置重排定时器。
   *
   * @param {string} cwd
   * @param {typeof DEFAULTS} settings
   */
  function schedule(cwd, settings) {
    stopTimer();
    if (!settings?.enabled || !cwd) return;
    timerCwd = cwd;
    lastChangeAt = null;
    const every = pollMs(settings);
    timer = setInterval(() => { void tick(cwd); }, every);
    // 定时器不能把宿主钉住不退出。
    timer.unref?.();
  }

  /**
   * 统一的「守卫 → 解析仓库 → 执行 → 释放」外壳。
   *
   * @param {string} action - 动作名，用于日志与错误信息。
   * @param {(args: { cwd: string, body: object }) => Promise<object>} run
   * @returns {(req: object, res: object) => Promise<void>}
   */
  function route(action, run) {
    return async (req, res) => {
      if (!guard(req, res)) return;
      try {
        const body = await readJsonBody(req);
        const repo = await resolveRepo(body, git);
        if (!repo.ok) {
          sendJson(res, 400, { ok: false, error: repo.error });
          return;
        }
        const result = await run({ cwd: repo.cwd, body });
        const status = result.ok ? 200 : result.conflicts?.length ? 409 : 400;
        sendJson(res, status, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger?.warn?.(`dsh-sync-panel: ${action} failed: ${message}`);
        sendJson(res, 500, { ok: false, error: message });
      } finally {
        guard.release();
      }
    };
  }

  const handlers = {
    /**
     * 记住/取回上次用的仓库目录。
     *
     * 这一条存在的唯一理由是：DSH 每次重启 web 端口都会变，localStorage
     * 按 origin 隔离，等于每次重启都丢。前端启动时先问这里，问到了就直接
     * 进主视图，不用再让用户重填一遍路径。
     *
     * 带 cwd 就写，不带就读。
     */
    repo: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      if (req.headers[MARKER_HEADER] !== '1') {
        sendJson(res, 403, { ok: false, error: `missing ${MARKER_HEADER} header` });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const next = typeof body?.cwd === 'string' ? body.cwd.trim() : '';
        if (next) {
          await writeRepo(next);
          sendJson(res, 200, { ok: true, cwd: next });
          return;
        }
        sendJson(res, 200, { ok: true, cwd: await readRepo() });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },

    /** 仓库概览：当前分支、上游、变更清单、最近提交、上次结果。 */
    status: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      if (req.headers[MARKER_HEADER] !== '1') {
        sendJson(res, 403, { ok: false, error: `missing ${MARKER_HEADER} header` });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const repo = await resolveRepo(body, git);
        if (!repo.ok) {
          sendJson(res, 400, { ok: false, error: repo.error });
          return;
        }
        const [status, branch, commits, selection, last, ahead, behind] = await Promise.all([
          gitStatus(repo.cwd),
          git.runGit(repo.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
          listRecent({ cwd: repo.cwd, count: 20, git }),
          readSelection(),
          readLast(),
          countAhead(repo.cwd),
          countBehind(repo.cwd),
        ]);
        sendJson(res, 200, {
          ok: true,
          cwd: repo.cwd,
          branch: branch.code === 0 ? branch.stdout.trim() : '',
          changes: status.changes,
          // 检测失败要如实送到界面。这里撒谎的代价是用户以为「一切都是
          // 最新的」，而实际上他改了半天的东西一个都没进版本库。
          statusError: status.ok ? null : status.error,
          commits,
          selection,
          last,
          // 欠推提交数。工作区干净但这里 > 0，说明上一次「提交成功、
          // 推送失败」。面板要能靠它把推送按钮留亮，否则那条提交永远
          // 推不上去——正是端到端验证抓到的那个死角。
          ahead: ahead,
          // 远端领先几个提交。只读本地引用，不联网（status 每次刷新都调）。
          // 主按钮靠它决定是「推送」还是「先拉一下」。
          behind: behind,
          busy: guard.isBusy(),
          // 这个仓库里有没有 bin/export.cjs。没有就把「从本机导出」按钮
          // 藏起来 —— 指到别的 git 仓库时那个按钮点了只会报错。
          canExport: await hasExporter(repo.cwd),
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },

    /** 保存勾选。 */
    selection: async (req, res) => {
      if (!guard(req, res)) return;
      try {
        const body = await readJsonBody(req);
        const sel = body?.selection && typeof body.selection === 'object' ? body.selection : {};
        const clean = {};
        for (const [k, v] of Object.entries(sel)) {
          if (typeof k === 'string' && k && typeof v === 'boolean') clean[k] = v;
        }
        await writeSelection(clean);
        sendJson(res, 200, { ok: true, count: Object.keys(clean).length });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      } finally {
        guard.release();
      }
    },

    /** 推送。 */
    push: route('push', async ({ cwd, body }) =>
      push({ cwd, paths: body?.paths, message: body?.message, git, state }),
    ),

    /** 拉取。 */
    pull: route('pull', async ({ cwd }) => pull({ cwd, git, state })),

    /**
     * 把本机的 ~/.dsh 刷新进快照仓库的 layer/。
     *
     * 加锁：它会在工作区里写一批文件，和推送并行的话，推送可能抓到
     * 写到一半的 layer。宁可让用户等这几秒。
     */
    export: route('export', async ({ cwd }) => {
      const result = await exportLayer({ cwd });
      if (result.ok) {
        state.appendLog?.(`export ok ${cwd}`);
      } else {
        state.appendLog?.(`export failed ${cwd}: ${result.message}`);
      }
      return result;
    }),

    /** 回滚。 */
    rollback: route('rollback', async ({ cwd, body }) =>
      rollback({ cwd, target: body?.target, git, state }),
    ),

    /** 提交历史。 */
    history: route('history', async ({ cwd, body }) => ({
      ok: true,
      commits: await listRecent({ cwd, count: body?.count ?? 20, git }),
    })),

    /**
     * 冲突全貌：每个文件、每一块的两侧内容。
     *
     * 只是看：collectConflicts 读完会 abort，工作区回到合并前。
     */
    conflicts: route('conflicts', async ({ cwd }) => collectConflicts({ cwd, git })),

    /** 应用三路对比的选择并完成合并提交。 */
    resolve: route('resolve', async ({ cwd, body }) =>
      resolve({ cwd, choices: body?.choices, git, state }),
    ),

    /**
     * 读自动推送设置。
     *
     * 不加锁：它只读一个 JSON 文件，和 git 没有任何关系，占着锁会让
     * 面板每次刷新都跟推送打架。
     */
    auto: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      if (req.headers[MARKER_HEADER] !== '1') {
        sendJson(res, 403, { ok: false, error: `missing ${MARKER_HEADER} header` });
        return;
      }
      try {
        sendJson(res, 200, { ok: true, settings: normalize(await readAuto()), scheduled: scheduledCwd() });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },

    /**
     * 改自动推送设置。
     *
     * 保存之后立刻按新设置重排定时器 —— 否则用户从「30 分钟」改成
     * 「1 分钟」还得等旧定时器先跑一轮，看上去像没生效。
     */
    'auto-save': route('auto-save', async ({ cwd, body }) => {
      const settings = normalize(body?.settings);
      await writeAuto(settings);
      schedule(cwd, settings);
      return { ok: true, settings };
    }),

    /** 操作日志尾部。 */
    log: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      if (req.headers[MARKER_HEADER] !== '1') {
        sendJson(res, 403, { ok: false, error: `missing ${MARKER_HEADER} header` });
        return;
      }
      try {
        sendJson(res, 200, { ok: true, lines: await readLogTail(80) });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },

    /**
     * 单个文件的差异，供面板预览。
     *
     * path 校验用 isInsideRepo 而不是字符串比较：面板会把路径原样回传，
     * 而 `--` 之后的 `..\..\.ssh\id_rsa` 是完全合法的 git 参数。
     */
    diff: route('diff', async ({ cwd, body }) => {
      const p = typeof body?.path === 'string' ? body.path : '';
      if (!isInsideRepo(cwd, p)) {
        return { ok: false, error: '路径越界' };
      }
      const r = await git.runGit(cwd, ['diff', '--', p]);
      if (r.code !== 0) return { ok: false, error: r.stderr || 'git diff 失败' };
      // 未跟踪文件没有 diff，改用整篇内容当作新增
      if (!r.stdout.trim()) {
        const cat = await git.runGit(cwd, ['diff', '--no-index', '--', '/dev/null', p]);
        return { ok: true, path: p, diff: cat.stdout || '（无差异）' };
      }
      return { ok: true, path: p, diff: r.stdout };
    }),
  };

  ctx.effect(() => {
    const unregisters = [];
    for (const [name, handler] of Object.entries(handlers)) {
      unregisters.push(ctx.webServer.register({ kind: 'exact', path: `${PREFIX}/${name}`, handler }));
    }
    // 恢复上次开着就还在开的自动推送。仓库目录存在 auto 里，
    // 因为面板关掉之后没人能再告诉插件「上次盯的是哪个目录」。
    void (async () => {
      try {
        const settings = normalize(await readAuto());
        const saved = await readLast();
        const cwd = typeof saved?.cwd === 'string' ? saved.cwd : '';
        if (settings.enabled && cwd) schedule(cwd, settings);
      } catch (error) {
        ctx.logger?.warn?.(`dsh-sync-panel: restore auto push failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();

    return () => {
      stopTimer();
      guard.release();
      for (const unregister of unregisters) unregister();
    };
  });
}
