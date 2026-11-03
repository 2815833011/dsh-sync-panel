/**
 * auto.test.mjs — 自动推送的决策。
 *
 * 只测 decide / normalize / pollMs 这三个纯函数。副作用（真正起定时器、
 * 真正调 push）在 index.js 里，测它需要整套宿主，性价比不划算；而
 * 「什么时候该推」的判断错一次就会把用户写到一半的文件推上去，所以
 * 这部分必须是纯函数，也必须被逐条盯住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalize, decide, pollMs } from '../lib/auto.js';

const ON = { ...DEFAULTS, enabled: true, mode: 'idle', idleSeconds: 300 };

/** 默认「有改动、不忙、没冲突」的一组输入，各测试只覆盖关心的字段。 */
function input(over) {
  return {
    settings: ON,
    now: 1_000_000_000,
    lastChangeAt: 1_000_000_000 - 400_000,
    lastRunAt: null,
    busy: false,
    hasChanges: true,
    hasConflicts: false,
    ...over,
  };
}

test('关闭时永远不推', () => {
  const r = decide(input({ settings: { ...ON, enabled: false } }));
  assert.equal(r.run, false);
  assert.equal(r.reason, 'disabled');
});

test('有操作在跑就跳过', () => {
  assert.equal(decide(input({ busy: true })).reason, 'busy');
});

test('有冲突待解决绝不自动推', () => {
  assert.equal(decide(input({ hasConflicts: true })).reason, 'conflicts');
});

test('没有改动就不推', () => {
  assert.equal(decide(input({ hasChanges: false })).reason, 'clean');
});

test('idle：还在写的时候不推', () => {
  // 改动发生在 100 秒前，但要求安静 300 秒
  const r = decide(input({ lastChangeAt: 1_000_000_000 - 100_000 }));
  assert.equal(r.run, false);
  assert.equal(r.reason, 'still-editing');
});

test('idle：安静够久就推', () => {
  const r = decide(input());
  assert.equal(r.run, true);
  assert.equal(r.reason, 'idle');
});

test('idle：安静时间刚好等于阈值时推（边界含等号）', () => {
  const r = decide(input({ lastChangeAt: 1_000_000_000 - 300_000 }));
  assert.equal(r.run, true, 'quiet === idleSeconds 应当算到点');
});

test('idle：看不到任何改动时间时不动', () => {
  const r = decide(input({ lastChangeAt: null }));
  assert.equal(r.run, false);
  assert.equal(r.reason, 'no-change-seen');
});

test('idle：推过之后改动没变就别重复推', () => {
  const r = decide(input({ lastRunAt: 1_000_000_000 - 200_000 }));
  assert.equal(r.run, false);
  assert.equal(r.reason, 'already-pushed');
});

test('idle：推过之后又有新改动，可以再推', () => {
  const r = decide(input({ lastRunAt: 1_000_000_000 - 500_000 }));
  assert.equal(r.run, true);
});

test('interval：第一次就推', () => {
  const s = { ...ON, mode: 'interval', intervalMinutes: 30 };
  const r = decide(input({ settings: s }));
  assert.equal(r.run, true);
  assert.equal(r.reason, 'interval-first');
});

test('interval：没到间隔不推', () => {
  const s = { ...ON, mode: 'interval', intervalMinutes: 30 };
  // 上次是 10 分钟前
  const r = decide(input({ settings: s, lastRunAt: 1_000_000_000 - 600_000 }));
  assert.equal(r.run, false);
  assert.equal(r.reason, 'not-due');
});

test('interval：到间隔就推', () => {
  const s = { ...ON, mode: 'interval', intervalMinutes: 30 };
  const r = decide(input({ settings: s, lastRunAt: 1_000_000_000 - 1_800_000 }));
  assert.equal(r.run, true);
  assert.equal(r.reason, 'interval');
});

test('interval：不看安静时间，只看间隔', () => {
  const s = { ...ON, mode: 'interval', intervalMinutes: 1 };
  // 改动就在 1 秒前，但间隔到了
  const r = decide(input({ settings: s, lastChangeAt: 1_000_000_000 - 1_000, lastRunAt: 1_000_000_000 - 120_000 }));
  assert.equal(r.run, true, 'interval 模式不该被 still-editing 拦住');
});

test('normalize 把超范围的值夹回边界', () => {
  const n = normalize({ enabled: true, mode: 'interval', idleSeconds: 1, intervalMinutes: 99999 });
  assert.equal(n.idleSeconds, 30, '低于下限应当夹到 30');
  assert.equal(n.intervalMinutes, 1440, '高于上限应当夹到 1440');
});

test('normalize 对垃圾输入给默认值', () => {
  const n = normalize({ idleSeconds: 'abc', mode: 'weird', enabled: 'yes' });
  assert.equal(n.idleSeconds, DEFAULTS.idleSeconds);
  assert.equal(n.mode, 'idle', '不认识的模式退回 idle');
  assert.equal(n.enabled, false, '只有真正的 true 才算开启');
});

test('normalize 对 null / undefined 不炸', () => {
  assert.deepEqual(normalize(null), DEFAULTS);
  assert.deepEqual(normalize(undefined), DEFAULTS);
});

test('pollMs 在 idle 模式下不超过 30 秒', () => {
  assert.ok(pollMs({ ...DEFAULTS, mode: 'idle', idleSeconds: 86400 }) <= 30_000);
  assert.ok(pollMs({ ...DEFAULTS, mode: 'idle', idleSeconds: 60 }) >= 5_000);
});

test('pollMs 在 interval 模式下是 1 分钟', () => {
  assert.equal(pollMs({ ...DEFAULTS, mode: 'interval' }), 60_000);
});
