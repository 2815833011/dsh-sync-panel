/**
 * lib/auto.js — 自动推送的决策与调度。
 *
 * 这块最容易出事的地方不是「推不推」，而是「推的时候有没有人在写」。
 * 所以决策函数是纯的：喂进去时间、设置、最近的改动时间，吐出一个
 * 明确的推 / 不推；真正的副作用（起定时器、调 push）留在 index.js。
 *
 * 两种模式：
 *   idle     —— 改动安静了 N 秒才推。适合「写到一半别打断」。
 *   interval —— 每隔 N 分钟推一次。适合「我就是要它一直在传」。
 *
 * 共同铁律：
 *   - 关掉就一个字节都不动。
 *   - 有操作在跑（busy）就跳过，下个 tick 再看。
 *   - 有冲突待解决时绝不自动推 —— 那时候推上去的是带标记的文件。
 */

/** 默认设置。故意全部关闭：自动推送是用户明确打开才会发生的事。 */
export const DEFAULTS = {
  enabled: false,
  mode: 'idle',
  idleSeconds: 300,
  intervalMinutes: 30,
  lastRunAt: null,
  lastResult: '',
  failures: 0,
};

/**
 * 连续失败多少次就自停。
 *
 * 没有这道闸，断网时 interval 模式会每分钟撞一次、每次写一行日志，
 * 一夜下来几千行，而用户第二天看到的只是一个「还在转」的面板。
 */
export const MAX_FAILURES = 3;

/** 允许的范围。超出范围的值直接夹到边界，而不是报错拒绝整个设置。 */
const MIN_IDLE = 30;
const MAX_IDLE = 86400;
const MIN_INTERVAL = 1;
const MAX_INTERVAL = 1440;

/**
 * 把用户给的值收拾成合法设置。
 *
 * 夹取而不是报错：面板上是个输入框，用户可能顺手打 0 或者 999999，
 * 让他整个自动推送失效比把值收进范围更糟。
 *
 * @param {unknown} raw
 * @returns {typeof DEFAULTS}
 */
export function normalize(raw) {
  const src = raw !== null && typeof raw === 'object' ? raw : {};
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(n)));

  return {
    enabled: src.enabled === true,
    mode: src.mode === 'interval' ? 'interval' : 'idle',
    idleSeconds: clamp(num(src.idleSeconds, DEFAULTS.idleSeconds), MIN_IDLE, MAX_IDLE),
    intervalMinutes: clamp(num(src.intervalMinutes, DEFAULTS.intervalMinutes), MIN_INTERVAL, MAX_INTERVAL),
    lastRunAt: typeof src.lastRunAt === 'string' ? src.lastRunAt : null,
    lastResult: typeof src.lastResult === 'string' ? src.lastResult : '',
    failures: clamp(num(src.failures, 0), 0, MAX_FAILURES),
  };
}

/**
 * 到点了吗？
 *
 * @param {object} input
 * @param {typeof DEFAULTS} input.settings
 * @param {number} input.now - 毫秒时间戳。
 * @param {number|null} input.lastChangeAt - 最近一次发现改动的时刻；没有改动传 null。
 * @param {number|null} input.lastRunAt - 上次自动推的时刻。
 * @param {boolean} input.busy - 是否有操作正在跑。
 * @param {boolean} input.hasChanges - 当前是否有未提交改动。
 * @param {boolean} input.hasConflicts - 是否有待解决的冲突。
 * @returns {{ run: boolean, reason: string }}
 */
export function decide({ settings, now, lastChangeAt, lastRunAt, busy, hasChanges, hasConflicts }) {
  if (!settings.enabled) return { run: false, reason: 'disabled' };
  // 连续失败到上限就停手，等用户看过原因再手动打开。
  if (settings.failures >= MAX_FAILURES) return { run: false, reason: 'too-many-failures' };
  if (busy) return { run: false, reason: 'busy' };
  if (hasConflicts) return { run: false, reason: 'conflicts' };
  if (!hasChanges) return { run: false, reason: 'clean' };
  // 刚推完、改动还没被重新发现时不要连推
  if (lastRunAt !== null && lastChangeAt !== null && lastChangeAt <= lastRunAt) {
    return { run: false, reason: 'already-pushed' };
  }

  if (settings.mode === 'interval') {
    const due = settings.intervalMinutes * 60 * 1000;
    if (lastRunAt === null) return { run: true, reason: 'interval-first' };
    return now - lastRunAt >= due ? { run: true, reason: 'interval' } : { run: false, reason: 'not-due' };
  }

  // idle 模式：改动必须已经安静够久
  if (lastChangeAt === null) return { run: false, reason: 'no-change-seen' };
  const quiet = now - lastChangeAt;
  if (quiet < settings.idleSeconds * 1000) return { run: false, reason: 'still-editing' };
  if (lastRunAt !== null && lastRunAt >= lastChangeAt) return { run: false, reason: 'already-pushed' };
  return { run: true, reason: 'idle' };
}

/**
 * 轮询间隔：够密才抓得住，但别把 CPU 和磁盘吵醒。
 *
 * idle 模式下最长 30 秒一次（否则「安静 5 分钟」会晚到几十秒）；
 * interval 模式下一分钟一次就够。
 *
 * @param {typeof DEFAULTS} settings
 * @returns {number} 毫秒
 */
export function pollMs(settings) {
  if (settings.mode === 'interval') return 60_000;
  return Math.min(30_000, Math.max(5_000, Math.round(settings.idleSeconds * 1000 / 10)));
}

/**
 * 一次自动推送之后新的设置。
 *
 * 成功要把失败计数清零，失败要加一 —— 分开写的话总有一边忘了，
 * 于是「失败三次自停」变成「永远不自停」或「成功一次也停」。
 *
 * @param {typeof DEFAULTS} settings
 * @param {{ ok: boolean, error?: string, committed?: number }} result
 * @param {number} [now] - 毫秒时间戳，测试用。
 * @returns {typeof DEFAULTS}
 */
export function afterRun(settings, result, now = Date.now()) {
  return {
    ...settings,
    failures: result.ok ? 0 : Math.min(MAX_FAILURES, settings.failures + 1),
    lastRunAt: new Date(now).toISOString(),
    lastResult: result.ok ? `成功 ${result.committed ?? 0} 个文件` : `失败：${result.error ?? '未知'}`,
  };
}
