/**
 * Browser half of dsh-sync-panel.
 *
 * Registers one sidebar icon and one main-area page. The page is a git panel:
 * pick which changed files belong in the snapshot, look at their diff, then
 * push / pull / roll back. Every button talks to the loopback-only Host routes
 * in `index.js`; nothing here shells out.
 *
 * Written as ONE file on purpose. The Host serves `client.js` to the browser
 * verbatim — there is no build step for a `link:`-installed plugin — so JSX and
 * local `import` statements would arrive untransformed. React is still used,
 * through `createElement`, because it is part of the shared baseline that
 * `require()` exposes (the same way `dsh-cost-meter` gets it).
 */

window.__ModuleLoader__.load({
  id: 'dsh-sync-panel',
  factory: (require) => {
    const React = require('react');
    const { useState, useEffect, useCallback, useRef, useMemo } = React;
    const h = React.createElement;

    const NS = 'dsh-sync-panel';
    const PANEL_ID = 'sync';
    const PREFIX = '/dsh-sync-panel';
    /** Every request carries this header; the Host rejects anything without it. */
    const HEADERS = { 'x-dsh-sync-panel': '1', 'content-type': 'application/json' };
    /** Remembered repository directory, so the panel opens where it left off. */
    const CWD_KEY = 'dsh-sync-panel:cwd';

    // ---------------------------------------------------------------------
    // 文案
    // ---------------------------------------------------------------------

    const ZH = {
      panel: '同步',
      panelTitle: '同步',
      subtitle: '把工作台的配置推到 git，或在另一台机器上拉回来',
      repoLabel: '仓库',
      repoPlaceholder: '例如 E:\\工作空间\\DSH工作台改造\\dsh-sync',
      repoApply: '使用此仓库',
      repoMissing: '还没有指定仓库目录',
      branch: '分支',
      filesTitle: '要同步的文件',
      filesEmpty: '没有变更，一切都是最新的',
      statusFailed: '变更检测失败，下面显示的不是真实状态',
      selectAll: '全选',
      selectNone: '全不选',
      diffTitle: '文件差异',
      diffEmpty: '点左边任一文件看它改了什么',
      diffLoading: '读取中…',
      push: '推送',
      pull: '拉取',
      rollback: '回滚',
      pushing: '推送中…',
      pulling: '拉取中…',
      rollingBack: '回滚中…',
      refresh: '刷新',
      messageLabel: '提交说明',
      messagePlaceholder: '留空则自动生成，例如「同步 2026-10-29 15:02 的 3 处改动」',
      logTitle: '操作日志',
      logEmpty: '还没有操作记录',
      logShow: '展开日志',
      logHide: '收起日志',
      historyTitle: '提交历史',
      historyPick: '选一个提交作为回滚目标',
      confirmRollback: '确认回滚到',
      cancel: '取消',
      busy: '另一个同步操作正在进行，稍后再点',
      nothingSelected: '先勾选要同步的文件',
      noChanges: '没有需要提交的改动',
      localOnly: '已在本地提交，但没有推送到远端',
      conflict: '有冲突需要处理',
      lastPrefix: '上次',
      noCommits: '还没有任何提交',
      statusM: '改',
      statusA: '新',
      statusD: '删',
      statusU: '冲',
      statusNew: '未跟踪',
      mergeTitle: '解决冲突',
      mergeHint: '每一块都选一边。全部选完才能提交，一处没选就不会写文件。',
      mergeOurs: '用我的',
      mergeTheirs: '用远端的',
      mergeBase: '共同祖先',
      mergeApply: '应用并提交',
      mergeCancel: '先不处理',
      mergeLeft: '还有 {n} 处没选',
      mergeDone: '冲突已解决并提交',
      mergeEmpty: '没有冲突要处理',
      mergeLoading: '正在读取冲突…',
      mergeApplying: '提交中…',
      mergeUnparsable: '这个文件的冲突标记不完整，只能手动处理',
      lineLabel: '从第',
      sideEmpty: '（这一段是空的）',
      autoTitle: '自动推送',
      autoOff: '关',
      autoOn: '开',
      autoHint: '打开后，改动安静够了就自动提交并推上去。有冲突时会停手等你处理。',
      autoModeIdle: '安静后推',
      autoModeInterval: '定时推',
      autoIdle: '安静多少秒',
      autoInterval: '每隔多少分钟',
      autoSave: '保存设置',
      autoSaved: '已保存',
      autoLastNever: '还没自动推过',
      autoLast: '上次自动推：{when}（{result}）',
      autoFailures: '连续失败 {n} 次',
      autoStopped: '连续失败 {n} 次，已自动停手。修好网络后重新打开。',
      autoScheduled: '正在盯着：{cwd}',
      autoNotScheduled: '当前没有在盯着任何仓库',
      // 主视图
      setupTitle: '先选一个仓库目录',
      setupHint: '这个目录里要有一个 git 仓库。面板只负责「文件 → 提交 → 远端」这一段；从 ~/.dsh 导出的快照仍由 export 脚本写入这个目录。',
      stateSynced: '已是最新',
      stateClean: '没有改动',
      stateChanges: '{n} 个文件有改动',
      stateAhead: '{n} 个提交没推上去',
      stateBehind: '远端多 {n} 个提交',
      stateBoth: '本地和远端都有新提交',
      stateBusy: '正在同步…',
      stateNoRepo: '还没有配置',
      lastNever: '还没同步过',
      lastOk: '上次同步成功',
      lastFail: '上次同步失败',
      lastLocalOnly: '上次只提交到本地，没推上去',
      primaryPushFiles: '推送 {n} 个文件',
      primaryPushCommits: '推送 {n} 个提交',
      primaryPullFirst: '先拉取 {n} 个提交',
      primaryPull: '拉取 {n} 个提交',
      primaryUpToDate: '已是最新',
      primaryResolve: '解决冲突',
      primaryRetry: '重试',
      detailOpen: '查看详情',
      detailTitle: '详情',
      tabFiles: '文件',
      tabHistory: '历史',
      tabLog: '日志',
      tabSettings: '设置',
      back: '返回',
      changesCard: '这次要同步什么',
      changesNone: '没有改动',
      changesHint: '默认全选。在详情里可以逐个勾选、看每个文件改了什么。',
      advancedCard: '更多',
      exportBtn: '从本机导出',
      exporting: '导出中…',
      exportOk: '已从本机导出到快照仓库',
      exportHint: '面板同步的是快照仓库里的副本。改了技能或宪法后先导出，再推送。',
      advancedHint: '提交历史、操作日志、自动推送',
      lastLabel: '上次同步',
      notConfigured: '未配置',
      refreshHint: '刷新状态',
    };

    const EN = {
      panel: 'Sync',
      panelTitle: 'Sync',
      subtitle: 'Push this workbench to git, or pull it back on another machine',
      repoLabel: 'Repository',
      repoPlaceholder: 'e.g. E:\\work\\dsh-sync',
      repoApply: 'Use this repository',
      repoMissing: 'No repository directory selected yet',
      branch: 'Branch',
      filesTitle: 'Files to sync',
      filesEmpty: 'Nothing changed; everything is up to date',
      statusFailed: 'Change detection failed; the state below is not reliable',
      selectAll: 'All',
      selectNone: 'None',
      diffTitle: 'Diff',
      diffEmpty: 'Pick a file on the left to see what changed',
      diffLoading: 'Reading…',
      push: 'Push',
      pull: 'Pull',
      rollback: 'Roll back',
      pushing: 'Pushing…',
      pulling: 'Pulling…',
      rollingBack: 'Rolling back…',
      refresh: 'Refresh',
      messageLabel: 'Commit message',
      messagePlaceholder: 'Leave empty to auto-generate one',
      logTitle: 'Log',
      logEmpty: 'No operations yet',
      logShow: 'Show log',
      logHide: 'Hide log',
      historyTitle: 'History',
      historyPick: 'Pick a commit to roll back to',
      confirmRollback: 'Roll back to',
      cancel: 'Cancel',
      busy: 'Another sync is already running; try again shortly',
      nothingSelected: 'Select at least one file first',
      noChanges: 'Nothing to commit',
      localOnly: 'Committed locally but not pushed',
      conflict: 'Conflicts need to be resolved',
      lastPrefix: 'Last',
      noCommits: 'No commits yet',
      statusM: 'M',
      statusA: 'A',
      statusD: 'D',
      statusU: 'C',
      statusNew: 'U',
      mergeTitle: 'Resolve conflicts',
      mergeHint: 'Pick one side for every block. Nothing is written until all blocks are chosen.',
      mergeOurs: 'Keep mine',
      mergeTheirs: 'Take theirs',
      mergeBase: 'Common ancestor',
      mergeApply: 'Apply and commit',
      mergeCancel: 'Not now',
      mergeLeft: '{n} block(s) still unchosen',
      mergeDone: 'Conflicts resolved and committed',
      mergeEmpty: 'Nothing to resolve',
      mergeLoading: 'Reading conflicts…',
      mergeApplying: 'Committing…',
      mergeUnparsable: 'This file has incomplete conflict markers; resolve it by hand',
      lineLabel: 'from line',
      sideEmpty: '(this side is empty)',
      autoTitle: 'Auto push',
      autoOff: 'Off',
      autoOn: 'On',
      autoHint: 'When on, changes are committed and pushed once they stop changing. Conflicts stop it until you resolve them.',
      autoModeIdle: 'After quiet',
      autoModeInterval: 'On schedule',
      autoIdle: 'Quiet for (seconds)',
      autoInterval: 'Every (minutes)',
      autoSave: 'Save',
      autoSaved: 'Saved',
      autoLastNever: 'Nothing pushed automatically yet',
      autoLast: 'Last auto push: {when} ({result})',
      autoFailures: '{n} consecutive failures',
      autoStopped: 'Stopped after {n} consecutive failures. Fix the network, then turn it on again.',
      autoScheduled: 'Watching: {cwd}',
      autoNotScheduled: 'Not watching any repository',
      // Main view
      setupTitle: 'Choose a repository first',
      setupHint: 'This directory must be a git repository. The panel only handles "files → commit → remote"; the export script still writes the snapshot from ~/.dsh into this directory.',
      stateSynced: 'Up to date',
      stateClean: 'No changes',
      stateChanges: '{n} file(s) changed',
      stateAhead: '{n} commit(s) not pushed',
      stateBehind: '{n} commit(s) upstream',
      stateBoth: 'New commits on both sides',
      stateBusy: 'Syncing…',
      stateNoRepo: 'Not configured',
      lastNever: 'Never synced',
      lastOk: 'Last sync succeeded',
      lastFail: 'Last sync failed',
      lastLocalOnly: 'Last sync committed locally but did not push',
      primaryPushFiles: 'Push {n} file(s)',
      primaryPushCommits: 'Push {n} commit(s)',
      primaryPullFirst: 'Pull {n} commit(s) first',
      primaryPull: 'Pull {n} commit(s)',
      primaryUpToDate: 'Everything is up to date',
      primaryResolve: 'Resolve conflicts',
      primaryRetry: 'Try again',
      detailOpen: 'Open details',
      detailTitle: 'Details',
      tabFiles: 'Files',
      tabHistory: 'History',
      tabLog: 'Log',
      tabSettings: 'Settings',
      back: 'Back',
      changesCard: 'What goes into this sync',
      changesNone: 'Nothing changed',
      changesHint: 'All selected by default. Open details to pick files one by one and see what changed.',
      advancedCard: 'More',
      advancedHint: 'Commit history, operation log, auto push',
      exportBtn: 'Export from this machine',
      exporting: 'Exporting…',
      exportOk: 'Exported from this machine into the snapshot repo',
      exportHint: 'The panel syncs a copy inside the snapshot repo. Export after changing skills or the constitution, then push.',
      lastLabel: 'Last sync',
      notConfigured: 'Not configured',
      refreshHint: 'Refresh status',
    };

    /** @returns {boolean} 当前是否为中文界面。 */
    function isZh() {
      const tag = typeof document === 'undefined' ? '' : document.documentElement.lang;
      return typeof tag === 'string' && tag.toLowerCase().startsWith('zh');
    }

    /** @param {string} key @param {Record<string, string|number>} [vars] @returns {string} */
    function t(key, vars) {
      const table = isZh() ? ZH : EN;
      const raw = table[key] ?? key;
      if (vars === undefined) return raw;
      // 只替换 {name} 形式的占位符，不碰其他花括号
      return raw.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
    }

    // ---------------------------------------------------------------------
    // 自动刷新
    // ---------------------------------------------------------------------

    /** 两次自动刷新之间至少隔这么久（毫秒）。 */
    const MIN_REFRESH_GAP = 3000;

    /**
     * 这一刻该不该刷新。
     *
     * 面板在后台（标签页不可见）时一律不刷 —— 用户看不见，刷了只是让
     * git 白跑。最小间隔是硬底线：focus 和 visibilitychange 经常同时
     * 触发，没有它一次切窗口就会连打两次 git。
     *
     * @param {{now: number, lastAt: number, hidden: boolean}} s
     * @returns {boolean}
     */
    function shouldRefresh(s) {
      if (s.hidden) return false;
      return s.now - s.lastAt >= MIN_REFRESH_GAP;
    }

    /**
     * 自动刷新的调度器。
     *
     * 拆成可在没有 DOM 的环境里测的形状：attach 负责挂事件，tick 负责
     * 定时那一半，两边共用同一个「该不该刷」判断。
     *
     * @param {{refresh: () => void, now?: () => number}} opts
     */
    function createAutoRefresh(opts) {
      const now = opts.now ?? (() => Date.now());
      let lastAt = 0;
      let doc = null;

      /** 后台判定读的是**挂上来的那个 doc**，不是全局 document。 */
      function isHidden() {
        return doc !== null && doc.hidden === true;
      }

      function markSeen() {
        lastAt = now();
      }

      function maybeRefresh() {
        const at = now();
        if (!shouldRefresh({ now: at, lastAt, hidden: isHidden() })) return;
        lastAt = at;
        opts.refresh();
      }

      /**
       * @param {Window} win
       * @param {Document} doc_
       * @returns {() => void} dispose
       */
      function attach(win, doc_) {
        if (!win || !doc_) return () => {};
        doc = doc_;
        win.addEventListener('focus', maybeRefresh);
        doc.addEventListener('visibilitychange', maybeRefresh);
        return () => {
          win.removeEventListener('focus', maybeRefresh);
          doc.removeEventListener('visibilitychange', maybeRefresh);
          if (doc === doc_) doc = null;
        };
      }

      return { attach, tick: maybeRefresh, markSeen };
    }

    // ---------------------------------------------------------------------
    // 与 Host 通信
    // ---------------------------------------------------------------------

    /** 本插件路由的绝对地址；同源优先，其次退回启动图里的 origin。 */
    function routeUrl(action) {
      const boot = typeof window === 'undefined' ? undefined : window.__DSH_BOOT__;
      const origin =
        typeof location !== 'undefined' && typeof location.origin === 'string' && location.origin.startsWith('http')
          ? location.origin
          : typeof boot === 'object' && boot !== null && typeof boot.origin === 'string' && boot.origin.startsWith('http')
            ? boot.origin
            : undefined;
      const path = `${PREFIX}/${action}`;
      return origin === undefined ? path : `${origin.replace(/\/+$/, '')}${path}`;
    }

    /**
     * 调一次 Host 路由。
     *
     * 网络断了、Host 返回非 JSON、HTTP 非 2xx 都折算成同一个 { ok:false, error }
     * 形状，调用方只需要看 ok 一个字段。
     *
     * @param {string} action
     * @param {object} [body]
     * @returns {Promise<{ ok: boolean, error?: string } & Record<string, unknown>>}
     */
    async function post(action, body) {
      let response;
      try {
        response = await fetch(routeUrl(action), {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify(body ?? {}),
          cache: 'no-store',
        });
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (payload === null || typeof payload !== 'object') {
        return { ok: false, error: `HTTP ${String(response.status)}` };
      }
      // Host 用 200/400/409 区分成功、失败、冲突，而 body 里始终带 ok 字段；
      // 以 body 的 ok 为准，HTTP 码只用来兜底（例如反代把 body 吃了）。
      if (typeof payload.ok === 'boolean') return payload;
      if (response.ok) return { ...payload, ok: true };
      const reason = typeof payload.error === 'string' && payload.error !== '' ? payload.error : `HTTP ${String(response.status)}`;
      return { ...payload, ok: false, error: reason };
    }

    // ---------------------------------------------------------------------
    // 样式
    // ---------------------------------------------------------------------

    /**
     * 样式表。
     *
     * 全部颜色都来自 DSH 自己的设计变量（--dsw-alias-* / --dsw-specific-*），
     * 所以面板会跟着 DSH 的深浅色主题自动变——主题切换就是在 body 上挂
     * data-ds-dark-theme，变量值随之改，这里一行都不用管。
     *
     * 每个 var() 后面的兜底值只在宿主没定义该变量时生效（例如面板被别处
     * 复用时）。兜底值刻意写成中性灰，而不是某个"好看"的深色——写死深色
     * 正是上一版在浅色主题下变黑块的原因。
     */
    const CSS = `
.dsp-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-base,transparent)}
.dsp-head{display:flex;align-items:baseline;gap:10px;padding:14px 18px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,currentColor)}
.dsp-head h2{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}
.dsp-sub{color:var(--dsw-alias-label-tertiary,inherit);font-size:12px}
.dsp-bar{display:flex;align-items:center;gap:8px;padding:10px 18px;border-bottom:1px solid var(--dsw-alias-border-l1,currentColor);flex-wrap:wrap}
.dsp-bar input.dsp-repo{flex:1 1 320px;min-width:200px;font-family:var(--dsw-font-mono,monospace);font-size:12px}
.dsp-input{background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2,currentColor);color:var(--dsw-alias-label-primary,inherit);border-radius:6px;padding:5px 8px;font-size:12px;outline:none}
.dsp-input:focus{border-color:var(--dsw-alias-state-business-primary,currentColor);box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) color-mix(in srgb,var(--dsw-alias-state-business-primary,currentColor) 25%,transparent)}
.dsp-btn{background:var(--dsw-alias-button-elevated-fill,transparent);border:1px solid var(--dsw-alias-border-l2,currentColor);color:var(--dsw-alias-label-primary,inherit);border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;white-space:nowrap}
.dsp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,transparent)}
.dsp-btn:disabled{opacity:.45;cursor:not-allowed}
.dsp-btn.primary{background:var(--dsw-alias-brand-primary,currentColor);border-color:transparent;color:var(--dsw-alias-label-primary-inverted,inherit);font-weight:500}
.dsp-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,currentColor)}
.dsp-btn.danger{color:var(--dsw-alias-state-error-primary,inherit)}
.dsp-btn.danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,transparent)}
.dsp-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;font-size:11px;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,inherit)}
.dsp-empty{padding:20px;color:var(--dsw-alias-label-caption,inherit);font-size:12px;line-height:1.6}
.dsp-msg{font-size:12px;line-height:1.55}
.dsp-msg.err{color:var(--dsw-alias-state-error-primary,inherit)}
.dsp-msg.ok{color:var(--dsw-alias-state-success-primary,inherit)}
.dsp-msg.warn{color:var(--dsw-alias-state-warn-primary,inherit)}
.dsp-busy{color:var(--dsw-alias-state-warn-primary,inherit)}
.dsp-log{border-top:1px solid var(--dsw-alias-border-l1,currentColor);max-height:180px;overflow:auto;padding:8px 18px;font-family:var(--dsw-font-mono,monospace);font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,inherit);white-space:pre-wrap}
.dsp-log.fill{max-height:none;flex:1;min-height:0;border-top:0;padding:12px 18px}

/* 主视图 */
.dsp-overview{flex:1;min-height:0;overflow:auto;padding:18px;display:flex;flex-direction:column;gap:14px}
.dsp-card{border:1px solid var(--dsw-alias-border-l1,currentColor);border-radius:10px;background:var(--dsw-alias-settings-card-fill,transparent);padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.dsp-card-head{display:flex;align-items:center;gap:8px}
.dsp-repo-name{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsp-repo-path{font-family:var(--dsw-font-mono,monospace);font-size:11px;color:var(--dsw-alias-label-caption,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.dsp-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px}
.dsp-chip{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:2px 9px;border:1px solid var(--dsw-alias-border-l2,currentColor);color:var(--dsw-alias-label-secondary,inherit);background:var(--dsw-alias-bg-layer-1,transparent)}
.dsp-chip.mono{font-family:var(--dsw-font-mono,monospace)}
.dsp-chip.ok{color:var(--dsw-alias-state-success-primary,inherit);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,currentColor) 35%,transparent)}
.dsp-chip.warn{color:var(--dsw-alias-state-warn-primary,inherit);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,currentColor) 40%,transparent)}
.dsp-chip.err{color:var(--dsw-alias-state-error-primary,inherit);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,currentColor) 40%,transparent)}
.dsp-dot{width:7px;height:7px;border-radius:50%;flex:none;background:currentColor}
.dsp-metric{display:flex;align-items:flex-end;gap:6px}
.dsp-metric .n{font-size:26px;font-weight:650;line-height:1.1;color:var(--dsw-alias-label-primary,inherit)}
.dsp-metric .u{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit);padding-bottom:3px}
.dsp-last{font-size:12px;color:var(--dsw-alias-label-secondary,inherit);line-height:1.6}
.dsp-last .when{font-family:var(--dsw-font-mono,monospace);color:var(--dsw-alias-label-tertiary,inherit)}
.dsp-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsp-primary-btn{font-size:13.5px;padding:9px 20px;border-radius:8px;font-weight:550}
.dsp-linkbtn{background:none;border:0;color:var(--dsw-alias-state-business-primary,inherit);font-size:12px;cursor:pointer;padding:4px 2px}
.dsp-linkbtn:hover{text-decoration:underline}
.dsp-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsp-input.wide{flex:1 1 300px;min-width:180px}

/* 详情覆盖层 */
.dsp-overlay{position:absolute;inset:0;background:var(--dsw-alias-bg-base,transparent);display:flex;flex-direction:column;z-index:5;min-height:0}
.dsp-overlay-head{display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,currentColor)}
.dsp-overlay-head h2{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}
.dsp-tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1,currentColor);padding:0 12px}
.dsp-tab{background:none;border:0;border-bottom:2px solid transparent;color:var(--dsw-alias-label-tertiary,inherit);padding:7px 10px;font-size:12px;cursor:pointer}
.dsp-tab.on{color:var(--dsw-alias-label-primary,inherit);border-bottom-color:var(--dsw-alias-brand-primary,currentColor)}
.dsp-overlay-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto}
.dsp-cols{display:grid;grid-template-columns:320px 1fr;flex:1;min-height:0}
.dsp-left{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l1,currentColor)}
.dsp-files{overflow:auto;flex:1;min-height:0;padding:4px 0}
.dsp-dir{padding:6px 12px 2px;font-size:11px;color:var(--dsw-alias-label-caption,inherit);font-family:var(--dsw-font-mono,monospace)}
.dsp-file{display:flex;align-items:center;gap:6px;padding:3px 12px;cursor:pointer;font-family:var(--dsw-font-mono,monospace);font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,inherit)}
.dsp-file:hover{background:var(--dsw-alias-interactive-bg-hover,transparent)}
.dsp-file.active{background:var(--dsw-alias-interactive-bg-active,transparent);color:var(--dsw-alias-label-primary,inherit)}
.dsp-file .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsp-badge{flex:none;min-width:14px;text-align:center;font-size:10px;border-radius:3px;padding:0 2px;font-weight:600}
.dsp-badge.M{color:var(--dsw-alias-state-warn-primary,inherit)}
.dsp-badge.A{color:var(--dsw-alias-state-success-primary,inherit)}
.dsp-badge.D{color:var(--dsw-alias-state-error-primary,inherit)}
.dsp-badge.U{color:var(--dsw-alias-state-error-primary,inherit)}
.dsp-badge.untracked{color:var(--dsw-alias-label-caption,inherit)}
.dsp-right{display:flex;flex-direction:column;min-height:0}
.dsp-diff{flex:1;min-height:0;overflow:auto;margin:0;padding:10px 14px;font-family:var(--dsw-font-mono,monospace);font-size:12px;line-height:1.55;white-space:pre;color:var(--dsw-alias-label-secondary,inherit)}
.dsp-diff .add{color:var(--dsw-alias-code-diff-added,var(--dsw-alias-state-success-primary,inherit))}
.dsp-diff .del{color:var(--dsw-alias-code-diff-deleted,var(--dsw-alias-state-error-primary,inherit))}
.dsp-diff .hunk{color:var(--dsw-alias-state-business-primary,inherit)}
.dsp-diff .meta{color:var(--dsw-alias-label-caption,inherit)}

/* 历史 */
.dsp-history{padding:6px 0}
.dsp-commit{display:flex;gap:8px;padding:4px 18px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}
.dsp-commit:hover{background:var(--dsw-alias-interactive-bg-hover,transparent)}
.dsp-commit.pick{background:var(--dsw-alias-interactive-bg-active,transparent);color:var(--dsw-alias-label-primary,inherit)}
.dsp-commit .sha{font-family:var(--dsw-font-mono,monospace);color:var(--dsw-alias-state-business-primary,inherit);flex:none}
.dsp-commit .subject{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsp-commit .when{flex:none;color:var(--dsw-alias-label-caption,inherit);font-size:11px}

/* 自动推送 */
.dsp-auto{display:flex;flex-direction:column;gap:8px}
.dsp-auto-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsp-auto-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}
.dsp-auto-row input[type=number]{width:90px}
.dsp-hint{color:var(--dsw-alias-label-caption,inherit);font-size:11.5px;line-height:1.6}
.dsp-warn{color:var(--dsw-alias-state-warn-primary,inherit);font-size:11.5px}
.dsp-switch{display:inline-flex;border:1px solid var(--dsw-alias-border-l2,currentColor);border-radius:6px;overflow:hidden}
.dsp-switch button{background:transparent;border:0;color:var(--dsw-alias-label-tertiary,inherit);padding:4px 12px;font-size:12px;cursor:pointer}
.dsp-switch button.on{background:var(--dsw-alias-brand-primary,currentColor);color:var(--dsw-alias-label-primary-inverted,inherit)}
.dsp-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2,currentColor);border-radius:6px;overflow:hidden}
.dsp-seg button{background:transparent;border:0;color:var(--dsw-alias-label-tertiary,inherit);padding:4px 10px;font-size:12px;cursor:pointer}
.dsp-seg button.on{background:var(--dsw-alias-interactive-bg-active,transparent);color:var(--dsw-alias-label-primary,inherit)}

/* 三路对比 */
.dsp-merge{position:absolute;inset:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,transparent);z-index:6;min-height:0}
.dsp-mhead{display:flex;align-items:baseline;gap:10px;padding:11px 18px;border-bottom:1px solid var(--dsw-alias-border-l1,currentColor)}
.dsp-mhead h2{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}
.dsp-mbody{flex:1;min-height:0;overflow:auto;padding:8px 18px}
.dsp-mfile{margin:6px 0 14px}
.dsp-mfile-name{font-family:var(--dsw-font-mono,monospace);font-size:12px;color:var(--dsw-alias-state-business-primary,inherit);padding:4px 0;position:sticky;top:0;background:var(--dsw-alias-bg-base,transparent);z-index:1}
.dsp-hunk{border:1px solid var(--dsw-alias-border-l2,currentColor);border-radius:8px;margin:6px 0;overflow:hidden}
.dsp-hunk.chosen{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,currentColor) 60%,transparent)}
.dsp-hunk-bar{display:flex;align-items:center;gap:8px;padding:5px 10px;background:var(--dsw-alias-bg-layer-1,transparent);font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}
.dsp-hunk-cols{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--dsw-alias-border-l1,currentColor)}
.dsp-side{background:var(--dsw-alias-bg-base,transparent);padding:8px 10px;min-width:0}
.dsp-side.ours{box-shadow:inset 2px 0 0 var(--dsw-alias-state-success-primary,currentColor)}
.dsp-side.theirs{box-shadow:inset 2px 0 0 var(--dsw-alias-state-warn-primary,currentColor)}
.dsp-side.pick{background:var(--dsw-alias-interactive-bg-active,transparent)}
.dsp-side-head{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);margin-bottom:4px;cursor:pointer;user-select:none}
.dsp-side pre{margin:0;font-family:var(--dsw-font-mono,monospace);font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,inherit)}
.dsp-hunk-base{display:none;padding:6px 10px;background:var(--dsw-alias-bg-layer-1,transparent);font-family:var(--dsw-font-mono,monospace);font-size:11px;line-height:1.5;white-space:pre-wrap;color:var(--dsw-alias-label-tertiary,inherit)}
.dsp-hunk-base.show{display:block}
.dsp-mfoot{border-top:1px solid var(--dsw-alias-border-l1,currentColor);padding:10px 18px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
`;

    /** 把样式插进文档一次。 */
    function ensureStyles() {
      if (typeof document === 'undefined') return;
      if (document.getElementById('dsh-sync-panel-css') !== null) return;
      const style = document.createElement('style');
      style.id = 'dsh-sync-panel-css';
      style.textContent = CSS;
      document.head.append(style);
    }

    // ---------------------------------------------------------------------
    // 小工具
    // ---------------------------------------------------------------------

    /** 状态码 → 徽标文字。 */
    function statusText(status) {
      if (status === '??') return t('statusNew');
      return t(`status${status}`) ?? status;
    }

    /** 状态码 → 徽标 class。 */
    function statusClass(status) {
      if (status === '??') return 'untracked';
      return status;
    }

    /** 把 diff 文本切成带颜色的行。 */
    function renderDiff(diff) {
      const lines = String(diff).split('\n');
      return lines.map((line, index) => {
        let cls = '';
        if (line.startsWith('+++') || line.startsWith('---')) cls = 'meta';
        else if (line.startsWith('+')) cls = 'add';
        else if (line.startsWith('-')) cls = 'del';
        else if (line.startsWith('@@')) cls = 'hunk';
        return h('div', { key: index, className: cls }, line === '' ? '\u00a0' : line);
      });
    }

    /** ISO 时间 → 本地面「10-29 15:02」，认不出的原样返回。 */
    function formatWhen(iso) {
      const stamp = Date.parse(String(iso));
      if (!Number.isFinite(stamp)) return String(iso ?? '');
      const d = new Date(stamp);
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    /** 路径按目录分组：返回 [[dir, files], ...]，目录按字典序。 */    function groupByDir(changes) {
      const groups = new Map();
      for (const change of changes) {
        const cut = change.path.lastIndexOf('/');
        const dir = cut === -1 ? '.' : change.path.slice(0, cut);
        if (!groups.has(dir)) groups.set(dir, []);
        groups.get(dir).push(change);
      }
      return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    }

    /**
     * 决定主按钮该做什么。纯函数，只吃状态、不碰 React，所以能单独测。
     *
     * 判断顺序是有讲究的，四条都是踩过的坑：
     *
     *  1. 冲突先于一切 —— 合并中途或冲突残留时，任何 git 写操作都会失败，
     *     先说「解决冲突」比让他点推送再看到报错诚实。
     *  2. 远端有提交时先拉再推 —— 此时直接推几乎必然被拒（non-fast-forward），
     *     用户看到的是一次失败，而不是「你该先拉」。
     *  3. 有勾选就推文件 —— 这是日常主路径。
     *  4. 只剩欠推提交时推提交 —— 工作区干净但仍欠推，说明上次推送失败过，
     *     这条路径不给留口子的话，那条提交永远推不上去。
     *
     * @returns {{ kind: 'busy'|'resolve'|'pull'|'push'|'none', label: string, disabled: boolean, n: number }}
     */
    function primaryAction({ busy, pendingConflicts, ahead, behind, selectedCount }) {
      const busyLabel = { push: 'pushing', pull: 'pulling', rollback: 'rollingBack' }[busy];
      if (busy) return { kind: 'busy', label: t(busyLabel ?? busy), disabled: true, n: 0 };
      if (pendingConflicts) return { kind: 'resolve', label: t('primaryResolve'), disabled: false, n: 0 };
      if (behind > 0 && selectedCount > 0) {
        return { kind: 'pull', label: t('primaryPullFirst', { n: behind }), disabled: false, n: behind };
      }
      if (behind > 0) return { kind: 'pull', label: t('primaryPull', { n: behind }), disabled: false, n: behind };
      if (selectedCount > 0) {
        return { kind: 'push', label: t('primaryPushFiles', { n: selectedCount }), disabled: false, n: selectedCount };
      }
      if (ahead > 0) return { kind: 'push', label: t('primaryPushCommits', { n: ahead }), disabled: false, n: ahead };
      return { kind: 'none', label: t('primaryUpToDate'), disabled: true, n: 0 };
    }

    /**
     * 状态徽标：把「欠推 / 落后 / 有改动」压成一句人话。
     * 同样是纯函数，理由同上——它是面板的主要信息来源，判错就会唬人。
     *
     * @returns {{ cls: 'ok'|'warn'|'err', text: string }}
     */
    function stateBadge({ busy, pendingConflicts, ahead, behind, changeCount }) {
      if (busy) return { cls: 'warn', text: t('stateBusy') };
      if (pendingConflicts) return { cls: 'err', text: t('conflict') };
      if (ahead > 0 && behind > 0) return { cls: 'warn', text: t('stateBoth') };
      if (ahead > 0) return { cls: 'warn', text: t('stateAhead', { n: ahead }) };
      if (behind > 0) return { cls: 'warn', text: t('stateBehind', { n: behind }) };
      if (changeCount > 0) return { cls: 'warn', text: t('stateChanges', { n: changeCount }) };
      return { cls: 'ok', text: t('stateSynced') };
    }

    // ---------------------------------------------------------------------
    // 图标
    // ---------------------------------------------------------------------

    /** 16px 的 git 分叉图形。 */
    function SyncIcon() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('circle', { cx: 4.5, cy: 3, r: 1.8, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('circle', { cx: 4.5, cy: 13, r: 1.8, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('circle', { cx: 11.5, cy: 8, r: 1.8, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'M4.5 4.8v6.4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { d: 'M4.5 8h5.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
      );
    }

    // ---------------------------------------------------------------------
    // 三路对比
    // ---------------------------------------------------------------------

    /** 把一段多行文本渲染成 pre，空段显示占位免得用户分不清「空」和「没加载」。 */
    function sideBody(text, emptyLabel) {
      const body = String(text ?? '');
      return h(
        'pre',
        null,
        body === '' ? h('span', { className: 'meta' }, emptyLabel) : body,
      );
    }

    /**
     * 一个冲突块：左右并排，点哪边就选哪边。
     *
     * 祖先段默认收起 —— diff3 的祖先段对「我知道自己在选什么」有帮助，但
     * 每块都摊开会把页面撑得很长，用户真正要看的是两侧。
     */
    function HunkBlock({ path, hunk, pick, onPick }) {
      const [baseOpen, setBaseOpen] = useState(false);
      const oursPick = pick === 'ours';
      const theirsPick = pick === 'theirs';

      return h(
        'div',
        { className: `dsp-hunk${pick === undefined ? '' : ' chosen'}` },
        h(
          'div',
          { className: 'dsp-hunk-bar' },
          h('span', null, `#${String(hunk.index + 1)} · ${t('lineLabel')} ${String(hunk.start + 1)}`),
          h('span', { style: { flex: 1 } }),
          hunk.base === ''
            ? null
            : h(
                'button',
                { className: 'dsp-btn', type: 'button', onClick: () => setBaseOpen((open) => !open) },
                `${t('mergeBase')} ${baseOpen ? '▾' : '▸'}`,
              ),
        ),
        hunk.base === ''
          ? null
          : h('div', { className: `dsp-hunk-base${baseOpen ? ' show' : ''}` }, hunk.base),
        h(
          'div',
          { className: 'dsp-hunk-cols' },
          h(
            'div',
            { className: `dsp-side ours${oursPick ? ' pick' : ''}` },
            h(
              'div',
              { className: 'dsp-side-head', onClick: () => onPick(path, hunk.id, 'ours') },
              `${t('mergeOurs')}${oursPick ? ' ✓' : ''}`,
            ),
            sideBody(hunk.ours, t('sideEmpty')),
          ),
          h(
            'div',
            { className: `dsp-side theirs${theirsPick ? ' pick' : ''}` },
            h(
              'div',
              { className: 'dsp-side-head', onClick: () => onPick(path, hunk.id, 'theirs') },
              `${t('mergeTheirs')}${theirsPick ? ' ✓' : ''}`,
            ),
            sideBody(hunk.theirs, t('sideEmpty')),
          ),
        ),
      );
    }

    /**
     * 冲突解决面板。
     *
     * 关键约束：只要有任意一块没选，提交按钮就是禁用的，并且在按钮旁直接
     * 写明还剩几处 —— Host 那边也会拒绝写出半成品，这里是同一条规矩的
     * 前端投影，不是替代。
     */
    function MergeView({ cwd, files, onClose, onResolved }) {
      const [picks, setPicks] = useState({});
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(null);
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const onPick = useCallback((path, hunkId, pick) => {
        setPicks((prev) => ({ ...prev, [`${path}\u0000${hunkId}`]: { path, hunkId, pick } }));
      }, []);

      const all = useMemo(() => files.flatMap((file) => file.hunks.map((hunk) => ({ file, hunk }))), [files]);
      const chosen = useMemo(
        () => all.filter((entry) => picks[`${entry.file.path}\u0000${entry.hunk.id}`] !== undefined).length,
        [all, picks],
      );
      const left = all.length - chosen;

      const submit = useCallback(async () => {
        if (busy || left !== 0) return;
        setBusy(true);
        setNotice(null);
        const choices = all.map((entry) => {
          const value = picks[`${entry.file.path}\u0000${entry.hunk.id}`];
          return { path: entry.file.path, hunkId: entry.hunk.id, pick: value.pick };
        });
        const result = await post('resolve', { cwd, choices });
        if (!alive.current) return;
        setBusy(false);
        if (!result.ok) {
          setNotice({ kind: 'err', text: result.error ?? 'unknown error' });
          return;
        }
        setNotice({ kind: 'ok', text: `${t('mergeDone')} ${String(result.sha ?? '')}` });
        await onResolved();
      }, [busy, left, all, picks, cwd, onResolved]);

      return h(
        'div',
        { className: 'dsp-merge' },
        h(
          'div',
          { className: 'dsp-mhead' },
          h('h2', null, t('mergeTitle')),
          h('span', { className: 'dsp-sub' }, t('mergeHint')),
        ),
        h(
          'div',
          { className: 'dsp-mbody' },
          files.length === 0
            ? h('div', { className: 'dsp-empty' }, t('mergeEmpty'))
            : files.map((file) =>
                h(
                  'div',
                  { className: 'dsp-mfile', key: file.path },
                  h('div', { className: 'dsp-mfile-name' }, file.path),
                  file.hunks.length === 0
                    ? h('div', { className: 'dsp-empty' }, t('mergeUnparsable'))
                    : file.hunks.map((hunk) =>
                        h(HunkBlock, {
                          key: hunk.id,
                          path: file.path,
                          hunk,
                          pick: picks[`${file.path}\u0000${hunk.id}`]?.pick,
                          onPick,
                        }),
                      ),
                ),
              ),
        ),
        h(
          'div',
          { className: 'dsp-mfoot' },
          h(
            'button',
            {
              className: 'dsp-btn primary',
              type: 'button',
              disabled: busy || left !== 0 || all.length === 0,
              onClick: () => void submit(),
            },
            busy ? t('mergeApplying') : t('mergeApply'),
          ),
          h(
            'button',
            { className: 'dsp-btn', type: 'button', disabled: busy, onClick: onClose },
            t('mergeCancel'),
          ),
          h('span', { className: 'dsp-sub' }, left === 0 ? '' : t('mergeLeft', { n: left })),
          notice === null
            ? null
            : h('span', { className: `dsp-msg ${notice.kind === 'ok' ? 'ok' : notice.kind === 'warn' ? 'warn' : 'err'}` }, notice.text),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // 自动推送设置卡片
    // ---------------------------------------------------------------------

    /**
     * 自动推送设置。
     *
     * 组件自己拉设置、自己保存，面板主流程不参与 —— 自动推送是「设好就
     * 忘掉」的东西，让它跟推送按钮共享 notice 反而会在推送时把设置提示冲掉。
     *
     * @param {{ cwd: string }} props
     */
    function AutoCard({ cwd }) {
      const [settings, setSettings] = useState(null);
      const [scheduled, setScheduled] = useState('');
      const [saving, setSaving] = useState(false);
      const [savedAt, setSavedAt] = useState('');
      const [error, setError] = useState('');
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const load = useCallback(async () => {
        const result = await post('auto', { cwd });
        if (!alive.current) return;
        if (!result.ok) {
          setError(result.error ?? 'unknown error');
          return;
        }
        setError('');
        setSettings(result.settings ?? null);
        setScheduled(String(result.scheduled ?? ''));
      }, [cwd]);

      useEffect(() => {
        void load();
      }, [load]);

      const patch = useCallback((next) => {
        setSettings((prev) => ({ ...(prev ?? {}), ...next }));
        setSavedAt('');
      }, []);

      const save = useCallback(async () => {
        if (saving || settings === null) return;
        setSaving(true);
        const result = await post('auto-save', { cwd, settings });
        if (!alive.current) return;
        setSaving(false);
        if (!result.ok) {
          setError(result.error ?? 'unknown error');
          return;
        }
        setError('');
        // 以 Host 夹取后的值为准：用户可能填了 0 或 999999。
        setSettings(result.settings ?? settings);
        setSavedAt(new Date().toLocaleTimeString('zh-CN'));
        await load();
      }, [cwd, load, saving, settings]);

      if (settings === null) {
        return error === ''
          ? h('div', { className: 'dsp-auto' }, h('span', { className: 'dsp-hint' }, t('autoTitle')))
          : h('div', { className: 'dsp-auto' }, h('span', { className: 'dsp-warn' }, error));
      }

      const enabled = settings.enabled === true;
      const stopped = Number(settings.failures ?? 0) >= 3;
      const last = typeof settings.lastRunAt === 'string' && settings.lastRunAt !== ''
        ? t('autoLast', {
            when: formatWhen(settings.lastRunAt),
            result: String(settings.lastResult ?? ''),
          })
        : t('autoLastNever');

      return h(
        'div',
        { className: 'dsp-auto' },
        h(
          'div',
          { className: 'dsp-auto-head' },
          h('span', null, t('autoTitle')),
          h('span', { className: 'dsp-sub' }, enabled ? t('autoOn') : t('autoOff')),
          h(
            'div',
            { className: 'dsp-switch' },
            h(
              'button',
              {
                type: 'button',
                className: enabled ? '' : 'on',
                onClick: () => patch({ enabled: false, failures: 0 }),
              },
              t('autoOff'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: enabled ? 'on' : '',
                onClick: () => patch({ enabled: true, failures: 0 }),
              },
              t('autoOn'),
            ),
          ),
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            { className: 'dsp-btn', type: 'button', disabled: saving, onClick: () => void save() },
            saving ? '…' : savedAt === '' ? t('autoSave') : t('autoSaved'),
          ),
        ),

        enabled
          ? h(
              'div',
              { className: 'dsp-auto-row' },
              h(
                'div',
                { className: 'dsp-seg' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: settings.mode === 'idle' ? 'on' : '',
                    onClick: () => patch({ mode: 'idle' }),
                  },
                  t('autoModeIdle'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: settings.mode === 'interval' ? 'on' : '',
                    onClick: () => patch({ mode: 'interval' }),
                  },
                  t('autoModeInterval'),
                ),
              ),
              // 只显示当前模式那个数字框：两个都摆着会让人以为两个都得填。
              settings.mode === 'interval'
                ? h(
                    'span',
                    null,
                    t('autoInterval'),
                    ' ',
                    h('input', {
                      className: 'dsp-input',
                      type: 'number',
                      min: 1,
                      max: 1440,
                      value: String(settings.intervalMinutes ?? 30),
                      onChange: (event) => patch({ intervalMinutes: Number(event.target.value) }),
                    }),
                  )
                : h(
                    'span',
                    null,
                    t('autoIdle'),
                    ' ',
                    h('input', {
                      className: 'dsp-input',
                      type: 'number',
                      min: 30,
                      max: 86400,
                      value: String(settings.idleSeconds ?? 300),
                      onChange: (event) => patch({ idleSeconds: Number(event.target.value) }),
                    }),
                  ),
            )
          : null,

        h('div', { className: 'dsp-hint' }, t('autoHint')),
        h('div', { className: 'dsp-hint' }, last),
        scheduled === '' ? h('div', { className: 'dsp-hint' }, t('autoNotScheduled')) : h('div', { className: 'dsp-hint' }, t('autoScheduled', { cwd: scheduled })),
        stopped ? h('div', { className: 'dsp-warn' }, t('autoStopped', { n: settings.failures })) : null,
        error === '' ? null : h('div', { className: 'dsp-warn' }, error),
      );
    }

    // ---------------------------------------------------------------------
    // 面板
    // ---------------------------------------------------------------------

    /**
     * 主面板。
     *
     * 状态分三类：仓库与变更（从 Host 拉）、勾选（本地 + 回写 Host）、
     * 一次操作的进行状态（busy / 消息 / 日志）。
     */
    function SyncPanel() {
      const [cwd, setCwd] = useState(() => {
        try {
          return window.localStorage.getItem(CWD_KEY) ?? '';
        } catch {
          return '';
        }
      });
      const [cwdDraft, setCwdDraft] = useState(cwd);
      const [status, setStatus] = useState(null);
      const [selection, setSelection] = useState({});
      const [activePath, setActivePath] = useState('');
      const [diff, setDiff] = useState('');
      const [diffLoading, setDiffLoading] = useState(false);
      const [message, setMessage] = useState('');
      const [busy, setBusy] = useState('');
      const [notice, setNotice] = useState(null);
      const [logLines, setLogLines] = useState([]);
      /** 详情覆盖层：null 关闭，否则是当前标签页 'files'|'history'|'log'|'settings'。 */
      const [detailTab, setDetailTab] = useState(null);
      const [rollbackTarget, setRollbackTarget] = useState('');
      // 非 null 表示三路对比面板打开着；数组是该次读到的冲突全貌
      const [mergeFiles, setMergeFiles] = useState(null);
      const [pendingConflicts, setPendingConflicts] = useState(false);
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      /** 记住目录。 */
      const rememberCwd = useCallback((next) => {
        setCwd(next);
        try {
          window.localStorage.setItem(CWD_KEY, next);
        } catch {
          /* 隐私模式下 localStorage 会抛，忽略即可 */
        }
        // 同时写回 Host：DSH 每次重启端口都变，localStorage 按 origin
        // 隔离，只靠它等于每次重启都要重填一遍路径。
        void post('repo', { cwd: next });
      }, []);

      /** 拉一次仓库概览。 */
      const refresh = useCallback(
        async (target) => {
          const repo = target === undefined ? cwd : target;
          if (!repo) {
            setStatus(null);
            return;
          }
          const result = await post('status', { cwd: repo });
          if (!alive.current) return;
          if (!result.ok) {
            setStatus({ error: result.error });
            return;
          }
          setStatus(result);
          // 勾选以 Host 记住的为准，没记住过的默认勾上——配置快照几乎总是全都要。
          const saved = result.selection && typeof result.selection === 'object' ? result.selection : {};
          const next = {};
          for (const change of result.changes ?? []) {
            next[change.path] = saved[change.path] !== false;
          }
          setSelection(next);
        },
        [cwd],
      );

      useEffect(() => {
        void refresh();
      }, [refresh]);

      /**
       * 自动刷新：切回窗口/标签页时重拉一次，前台每 60 秒兜一次底。
       *
       * 没有它，面板就是个开机时拍的快照——用户改完文件切回来，屏幕上
       * 还写着「没有改动」，于是以为同步坏了。这正是「变更检测不灵敏」
       * 的另一半根因。
       */
      useEffect(() => {
        if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
        if (!cwd) return undefined;

        const loop = createAutoRefresh({
          refresh: () => {
            if (alive.current) void refresh();
          },
        });
        // 刚 refresh() 过，先记基线，省掉挂载瞬间那次重复请求。
        loop.markSeen();
        const dispose = loop.attach(window, document);
        const timer = setInterval(() => loop.tick(), 60_000);
        return () => {
          clearInterval(timer);
          dispose();
        };
      }, [cwd, refresh]);

      /**
       * 启动时问 Host 上次用的仓库。
       *
       * localStorage 里通常已经有了，只有在「重启后端口变了」这种情况下
       * 才是空的 —— 而那恰好是用户最烦的时刻：明明配过一次，却要他再填一遍。
       */
      useEffect(() => {
        let cancelled = false;
        void (async () => {
          if (cwd !== '') return;
          const result = await post('repo', {});
          if (cancelled || !alive.current) return;
          const saved = typeof result?.cwd === 'string' ? result.cwd.trim() : '';
          if (!result.ok || !saved) return;
          setCwd(saved);
          setCwdDraft(saved);
          try {
            window.localStorage.setItem(CWD_KEY, saved);
          } catch {
            /* 忽略 */
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [cwd]);

      /** 每次操作后刷新状态与日志。 */
      const afterAction = useCallback(async () => {
        if (!alive.current) return;
        const [fresh, logResult] = await Promise.all([post('status', { cwd }), post('log', { cwd })]);
        if (!alive.current) return;
        if (fresh.ok) setStatus(fresh);
        if (logResult.ok) setLogLines(logResult.lines ?? []);
      }, [cwd]);

      useEffect(() => {
        if (detailTab !== 'log') return;
        void (async () => {
          const result = await post('log', { cwd });
          if (alive.current && result.ok) setLogLines(result.lines ?? []);
        })();
      }, [detailTab, cwd]);

      /** 打开一个文件的差异。 */
      const openDiff = useCallback(
        async (path) => {
          setActivePath(path);
          setDiffLoading(true);
          const result = await post('diff', { cwd, path });
          if (!alive.current) return;
          setDiffLoading(false);
          setDiff(result.ok ? String(result.diff ?? '') : `（读取失败：${result.error}）`);
        },
        [cwd],
      );

      const changes = Array.isArray(status?.changes) ? status.changes : [];
      // 后端检测失败时会把原因放在 statusError。界面必须把这条显示出来，
      // 而不是落进「0 个改动 / 一切都是最新的」——那句安慰话在这里是撒谎。
      const statusError = status?.statusError ? String(status.statusError) : null;
      const selectedPaths = useMemo(
        () => changes.filter((change) => selection[change.path] !== false).map((change) => change.path),
        [changes, selection],
      );

      /** 保存勾选（失败不打断，只是下次打开不记得）。 */
      const persistSelection = useCallback((next) => {
        void post('selection', { cwd, selection: next });
      }, [cwd]);

      const toggle = useCallback(
        (path) => {
          setSelection((prev) => {
            const next = { ...prev, [path]: prev[path] === false };
            persistSelection(next);
            return next;
          });
        },
        [persistSelection],
      );

      const setAll = useCallback(
        (value) => {
          const next = {};
          for (const change of changes) next[change.path] = value;
          setSelection(next);
          persistSelection(next);
        },
        [changes, persistSelection],
      );

      /** 拉取遇到冲突后，读一次冲突全貌并打开三路对比。 */
      const openMerge = useCallback(async () => {
        setMergeFiles(null);
        setNotice({ kind: 'ok', text: t('mergeLoading') });
        const result = await post('conflicts', { cwd });
        if (!alive.current) return;
        if (!result.ok) {
          setNotice({ kind: 'err', text: result.error ?? 'unknown error' });
          return;
        }
        setNotice(null);
        setMergeFiles(Array.isArray(result.files) ? result.files : []);
      }, [cwd]);

      /** 执行一次会动 git 的操作。 */
      const run = useCallback(
        async (kind, body, pendingText) => {
          if (busy) return;
          setBusy(kind);
          setNotice(null);
          const result = await post(kind, { cwd, ...body });
          if (!alive.current) return;
          setBusy('');
          if (result.ok) {
            setPendingConflicts(false);
            const committed = Number(result.committed ?? 0);
            if (kind === 'push') {
              setNotice({ kind: 'ok', text: committed > 0 ? `已推送 ${committed} 个文件` : t('noChanges') });
              if (committed > 0) setMessage('');
            } else {
              setNotice({ kind: 'ok', text: pendingText });
            }
            setRollbackTarget('');
            await afterAction();
          } else if (Array.isArray(result.conflicts) && result.conflicts.length > 0) {
            // pull 冲突：Host 已经 abort 掉了合并，仓库回到干净状态。
            // 这里只报告是哪些文件，并亮出「解决冲突」入口 —— 真正的选择
            // 在 openMerge 里重新做一次合并之后再问他。
            setPendingConflicts(true);
            setNotice({ kind: 'err', text: `${t('conflict')}：${result.conflicts.join('、')}` });
            await afterAction();
          } else if (result.localOnly === true) {
            // 提交成功、推送失败。这不是普通失败：工作区已经干净，
            // 用户以为什么都没做，实际本地多了一条提交。必须说清楚，
            // 并让推送按钮保持可点（status 里的 ahead 会亮着）。
            setPendingConflicts(false);
            setNotice({
              kind: 'warn',
              text: `${result.message ?? t('localOnly')}：${result.error ?? ''}`.trim(),
            });
            await afterAction();
          } else {
            setNotice({ kind: 'err', text: result.error ?? 'unknown error' });
            await afterAction();
          }
        },
        [busy, cwd, afterAction],
      );

      /**
       * 从本机导出。
       *
       * 走的是同一条 post，但单独一个函数而不是塞进 run：导出的结果文案
       * 是后端算出来的（可能包含 stderr 摘要），run 那套固定文案套不上。
       * 仍然复用 busy 锁 —— 导出在写工作区，此时推送会抓到写一半的 layer。
       */
      const doExport = useCallback(async () => {
        if (busy) return;
        setBusy('export');
        setNotice(null);
        const result = await post('export', { cwd });
        if (!alive.current) return;
        setBusy('');
        if (result.ok) {
          setNotice({ kind: 'ok', text: result.message || t('exportOk') });
        } else {
          setNotice({ kind: 'err', text: result.message || result.error || 'export failed' });
        }
        await afterAction();
      }, [busy, cwd, afterAction]);

      // -------------------------------------------------------------------
      // 派生状态：一个按钮、一句话，全靠这几行决定
      // -------------------------------------------------------------------

      const ahead = Number(status?.ahead ?? 0);
      const behind = Number(status?.behind ?? 0);
      const groups = groupByDir(changes);
      const repoName = String(status?.cwd ?? cwd).split(/[\\/]/).filter(Boolean).pop() ?? '';

      const doPush = () => void run('push', { paths: selectedPaths, message: message.trim() || undefined }, '');
      const doPull = () => void run('pull', {}, t('pull'));

      // 主按钮永远只有一个，且永远指向「下一步最该做的事」。判断规则见
      // primaryAction 的注释——放在外面是为了能脱离 React 单独测。
      const decision = primaryAction({
        busy,
        pendingConflicts,
        ahead,
        behind,
        selectedCount: selectedPaths.length,
      });
      const primary = {
        label: decision.label,
        disabled: decision.disabled,
        run:
          decision.kind === 'resolve'
            ? () => void openMerge()
            : decision.kind === 'pull'
              ? doPull
              : decision.kind === 'push'
                ? doPush
                : null,
      };

      /** 状态徽标：把三个数字压成一句人话。 */
      function stateChip() {
        return stateBadge({ busy, pendingConflicts, ahead, behind, changeCount: changes.length });
      }

      /** 「上次同步」那一行：时间、结果、提交号。 */
      function lastLine() {
        const last = status?.last;
        if (!last || !last.at) return h('div', { className: 'dsp-last' }, t('lastNever'));
        const verdict = last.localOnly === true ? t('lastLocalOnly') : last.action === 'pull' ? t('pull') : t('lastOk');
        const cls = last.localOnly === true ? 'warn' : '';
        return h(
          'div',
          { className: 'dsp-last' },
          h('span', { className: cls }, verdict),
          ' · ',
          h('span', { className: 'when' }, formatWhen(last.at)),
          last.sha ? h('span', { className: 'when' }, ` · ${last.sha}`) : null,
          last.subject ? h('span', null, ` · ${last.subject}`) : null,
        );
      }

      const chip = stateChip();

      // -------------------------------------------------------------------
      // 详情覆盖层
      // -------------------------------------------------------------------

      function detailOverlay() {
        const tabs = [
          ['files', t('tabFiles')],
          ['history', t('tabHistory')],
          ['log', t('tabLog')],
          ['settings', t('tabSettings')],
        ];

        let body;
        if (detailTab === 'files') {
          body = h(
            'div',
            { className: 'dsp-cols' },
            h(
              'div',
              { className: 'dsp-left' },
              h(
                'div',
                { className: 'dsp-section-head' },
                h('span', null, `${t('filesTitle')} · ${selectedPaths.length}/${changes.length}`),
                h(
                  'span',
                  null,
                  h('button', { className: 'dsp-linkbtn', type: 'button', onClick: () => setAll(true) }, t('selectAll')),
                  h('button', { className: 'dsp-linkbtn', type: 'button', onClick: () => setAll(false) }, t('selectNone')),
                ),
              ),
              h(
                'div',
                { className: 'dsp-files' },
                groups.length === 0
                  ? h('div', { className: 'dsp-empty' }, t('filesEmpty'))
                  : groups.map(([dir, files]) =>
                      h(
                        'div',
                        { key: dir },
                        h('div', { className: 'dsp-dir' }, dir),
                        files.map((change) =>
                          h(
                            'div',
                            {
                              key: change.path,
                              className: `dsp-file${activePath === change.path ? ' active' : ''}`,
                              onClick: () => void openDiff(change.path),
                            },
                            h('input', {
                              type: 'checkbox',
                              checked: selection[change.path] !== false,
                              onClick: (event) => event.stopPropagation(),
                              onChange: () => toggle(change.path),
                            }),
                            h('span', { className: 'name', title: change.path }, change.path.slice(dir === '.' ? 0 : dir.length + 1)),
                            h('span', { className: `dsp-badge ${statusClass(change.status)}` }, statusText(change.status)),
                          ),
                        ),
                      ),
                    ),
              ),
            ),
            h(
              'div',
              { className: 'dsp-right' },
              h('div', { className: 'dsp-section-head' }, h('span', null, t('diffTitle')), h('span', null, activePath)),
              diffLoading
                ? h('div', { className: 'dsp-empty' }, t('diffLoading'))
                : diff === ''
                  ? h('div', { className: 'dsp-empty' }, t('diffEmpty'))
                  : h('pre', { className: 'dsp-diff' }, renderDiff(diff)),
            ),
          );
        } else if (detailTab === 'history') {
          const commits = status?.commits ?? [];
          body = h(
            'div',
            { className: 'dsp-overlay-body' },
            h(
              'div',
              { className: 'dsp-section-head' },
              h('span', null, t('historyTitle')),
              h('span', null, t('historyPick')),
            ),
            commits.length === 0
              ? h('div', { className: 'dsp-empty' }, t('noCommits'))
              : h(
                  'div',
                  { className: 'dsp-history' },
                  commits.map((commit) =>
                    h(
                      'div',
                      {
                        key: commit.sha,
                        className: `dsp-commit${rollbackTarget === commit.sha ? ' pick' : ''}`,
                        onClick: () => setRollbackTarget(commit.sha),
                      },
                      h('span', { className: 'sha' }, commit.sha),
                      h('span', { className: 'subject' }, commit.subject),
                      h('span', { className: 'when' }, formatWhen(commit.at)),
                    ),
                  ),
                ),
            h(
              'div',
              { className: 'dsp-mfoot' },
              h(
                'button',
                {
                  className: 'dsp-btn danger',
                  type: 'button',
                  disabled: busy !== '' || rollbackTarget === '',
                  onClick: () => {
                    if (rollbackTarget === '') return;
                    void run('rollback', { target: rollbackTarget }, `${t('confirmRollback')} ${rollbackTarget}`);
                  },
                },
                busy === 'rollback'
                  ? t('rollingBack')
                  : `${t('rollback')}${rollbackTarget === '' ? '' : ` → ${rollbackTarget}`}`,
              ),
            ),
          );
        } else if (detailTab === 'log') {
          body = h(
            'div',
            { className: 'dsp-overlay-body' },
            h('pre', { className: 'dsp-log fill' }, logLines.length === 0 ? t('logEmpty') : logLines.join('\n')),
          );
        } else {
          body = h(
            'div',
            { className: 'dsp-overlay-body', style: { padding: '14px 18px', gap: '14px' } },
            h(
              'div',
              { className: 'dsp-card' },
              h('div', { className: 'dsp-auto-row' },
                h('span', { className: 'dsp-sub' }, t('repoLabel')),
                h('input', {
                  className: 'dsp-input wide',
                  type: 'text',
                  value: cwdDraft,
                  placeholder: t('repoPlaceholder'),
                  spellCheck: false,
                  onChange: (event) => setCwdDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key !== 'Enter') return;
                    const next = cwdDraft.trim();
                    rememberCwd(next);
                    void refresh(next);
                  },
                }),
                h(
                  'button',
                  {
                    className: 'dsp-btn',
                    type: 'button',
                    onClick: () => {
                      const next = cwdDraft.trim();
                      rememberCwd(next);
                      void refresh(next);
                    },
                  },
                  t('repoApply'),
                ),
              ),
              h('div', { className: 'dsp-hint' }, t('setupHint')),
            ),
            // 自动推送卡片也要有卡片外壳：它原来是直接塞进滚动容器的，
            // 没有左右内边距，内容会顶到边框上、看着像溢出。
            h('div', { className: 'dsp-card' }, h(AutoCard, { cwd })),
          );
        }

        return h(
          'div',
          { className: 'dsp-overlay' },
          h(
            'div',
            { className: 'dsp-overlay-head' },
            h(
              'button',
              { className: 'dsp-btn', type: 'button', onClick: () => setDetailTab(null) },
              `← ${t('back')}`,
            ),
            h('h2', null, t('detailTitle')),
            h('span', { className: 'dsp-sub' }, repoName),
          ),
          h(
            'div',
            { className: 'dsp-tabs' },
            tabs.map(([key, label]) =>
              h(
                'button',
                {
                  key,
                  type: 'button',
                  className: `dsp-tab${detailTab === key ? ' on' : ''}`,
                  onClick: () => setDetailTab(key),
                },
                label,
              ),
            ),
          ),
          body,
        );
      }

      // -------------------------------------------------------------------
      // 主视图：一块状态、一块变更、一个大按钮
      // -------------------------------------------------------------------

      function overview() {
        const configured = cwd !== '' && status !== null && !status.error;

        if (!configured) {
          return h(
            'div',
            { className: 'dsp-overview' },
            h(
              'div',
              { className: 'dsp-card' },
              h('div', { className: 'dsp-card-head' }, h('span', { className: 'dsp-repo-name' }, t('setupTitle'))),
              h('div', { className: 'dsp-auto-row' },
                h('input', {
                  className: 'dsp-input wide',
                  type: 'text',
                  value: cwdDraft,
                  placeholder: t('repoPlaceholder'),
                  spellCheck: false,
                  onChange: (event) => setCwdDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key !== 'Enter') return;
                    const next = cwdDraft.trim();
                    rememberCwd(next);
                    void refresh(next);
                  },
                }),
                h(
                  'button',
                  {
                    className: 'dsp-btn primary',
                    type: 'button',
                    onClick: () => {
                      const next = cwdDraft.trim();
                      rememberCwd(next);
                      void refresh(next);
                    },
                  },
                  t('repoApply'),
                ),
              ),
              status !== null && status.error
                ? h('div', { className: 'dsp-msg err' }, status.error)
                : h('div', { className: 'dsp-hint' }, t('setupHint')),
            ),
          );
        }

        return h(
          'div',
          { className: 'dsp-overview' },
          // 检测失败时先把丑话摆在最上面：下面那几张卡显示的数字和
          // 「没有改动」都不可信，不能让用户照着它做决定。
          statusError === null
            ? null
            : h(
                'div',
                { className: 'dsp-msg err', title: statusError },
                `${t('statusFailed')}：${statusError}`,
              ),
          // 状态卡
          h(
            'div',
            { className: 'dsp-card' },
            h(
              'div',
              { className: 'dsp-card-head' },
              h('span', { className: 'dsp-repo-name' }, repoName || t('stateNoRepo')),
              h('span', { className: 'dsp-repo-path', title: String(status?.cwd ?? cwd) }, String(status?.cwd ?? cwd)),
            ),
            h(
              'div',
              { className: 'dsp-chips' },
              h('span', { className: 'dsp-chip mono' }, status?.branch || '—'),
              h('span', { className: `dsp-chip ${chip.cls}` }, h('span', { className: 'dsp-dot' }), chip.text),
            ),
            lastLine(),
            h(
              'div',
              { className: 'dsp-actions' },
              h(
                'button',
                {
                  className: 'dsp-btn primary dsp-primary-btn',
                  type: 'button',
                  disabled: primary.disabled,
                  onClick: primary.run ?? undefined,
                },
                primary.label,
              ),
              h(
                'button',
                { className: 'dsp-linkbtn', type: 'button', onClick: () => setDetailTab('files') },
                t('detailOpen'),
              ),
              h('span', { style: { flex: 1 } }),
              h('button', { className: 'dsp-btn', type: 'button', onClick: () => void refresh() }, t('refreshHint')),
            ),
            notice === null
              ? null
              : h('div', { className: `dsp-msg ${notice.kind === 'ok' ? 'ok' : notice.kind === 'warn' ? 'warn' : 'err'}` }, notice.text),
          ),

          // 变更卡
          h(
            'div',
            { className: 'dsp-card' },
            h(
              'div',
              { className: 'dsp-card-head' },
              h('span', { className: 'dsp-repo-name' }, t('changesCard')),
              h('span', { style: { flex: 1 } }),
              h(
                'button',
                { className: 'dsp-linkbtn', type: 'button', onClick: () => setDetailTab('files') },
                t('detailOpen'),
              ),
            ),
            changes.length === 0 && statusError !== null
              ? h('div', { className: 'dsp-metric' }, h('span', { className: 'n' }, '?'), h('span', { className: 'u' }, t('changesNone')))
              : changes.length === 0
                ? h('div', { className: 'dsp-metric' }, h('span', { className: 'n' }, '0'), h('span', { className: 'u' }, t('changesNone')))
                : h('div', { className: 'dsp-metric' },
                    h('span', { className: 'n' }, String(selectedPaths.length)),
                    h('span', { className: 'u' }, `/ ${changes.length}`),
                  ),
            changes.length === 0 && statusError !== null
              ? h('div', { className: 'dsp-hint' }, t('statusFailed'))
              : changes.length === 0
                ? h('div', { className: 'dsp-hint' }, t('filesEmpty'))
                : h(
                  'div',
                  { className: 'dsp-chips' },
                  changes.slice(0, 6).map((change) =>
                    h(
                      'span',
                      { key: change.path, className: 'dsp-chip mono', title: change.path },
                      h('span', { className: `dsp-badge ${statusClass(change.status)}` }, statusText(change.status)),
                      change.path.split('/').pop(),
                    ),
                  ),
                  changes.length > 6
                    ? h('span', { className: 'dsp-chip' }, `+${changes.length - 6}`)
                    : null,
                ),
            changes.length === 0 ? null : h('div', { className: 'dsp-hint' }, t('changesHint')),
          ),

          // 更多
          h(
            'div',
            { className: 'dsp-card' },
            h(
              'div',
              { className: 'dsp-card-head' },
              h('span', { className: 'dsp-repo-name' }, t('advancedCard')),
              h('span', { style: { flex: 1 } }),
              h('span', { className: 'dsp-hint' }, t('advancedHint')),
            ),
            h(
              'div',
              { className: 'dsp-actions' },
              h('button', { className: 'dsp-btn', type: 'button', onClick: () => setDetailTab('history') }, t('tabHistory')),
              h('button', { className: 'dsp-btn', type: 'button', onClick: () => setDetailTab('log') }, t('tabLog')),
              h('button', { className: 'dsp-btn', type: 'button', onClick: () => setDetailTab('settings') }, t('tabSettings')),
              status?.canExport === false
                ? null
                : h(
                    'button',
                    { className: 'dsp-btn', type: 'button', disabled: busy !== '', onClick: () => void doExport() },
                    busy === 'export' ? t('exporting') : t('exportBtn'),
                  ),
            ),
            status?.canExport === false
              ? null
              : h('div', { className: 'dsp-hint' }, t('exportHint')),
          ),
        );
      }

      return h(
        'div',
        { className: 'dsp-root' },
        h(
          'div',
          { className: 'dsp-head' },
          h('h2', null, t('panelTitle')),
          h('span', { className: 'dsp-sub' }, t('subtitle')),
        ),
        detailTab === null ? overview() : detailOverlay(),
        mergeFiles === null
          ? null
          : h(MergeView, {
              cwd,
              files: mergeFiles,
              onClose: () => setMergeFiles(null),
              onResolved: async () => {
                setMergeFiles(null);
                setPendingConflicts(false);
                await afterAction();
              },
            }),
      );
    }
    // ---------------------------------------------------------------------
    // 注册
    // ---------------------------------------------------------------------

    /** 依赖的浏览器能力。 */
    const inject = ['slots', 'layout'];

    /**
     * @param {object} ctx
     */
    function apply(ctx) {
      if (typeof document === 'undefined') return;
      ensureStyles();

      ctx.effect(() =>
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 100,
              label: () => t('panel'),
              locale: NS,
            },
            SyncIcon,
          ),
        ),
      );

      ctx.effect(() =>
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
            },
            SyncPanel,
          ),
        ),
      );
    }

    // 测试出口：Host 只读 name/apply/inject，多出来的键不影响装配，
    // 但让 test/client.test.mjs 能直接渲染冲突面板，而不是只测到骨架。
    return {
      name: NS,
      apply,
      inject,
      __test: {
        MergeView,
        HunkBlock,
        AutoCard,
        t,
        groupByDir,
        primaryAction,
        stateBadge,
        shouldRefresh,
        createAutoRefresh,
      },
    };
  },
});
