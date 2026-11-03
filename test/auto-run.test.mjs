/**
 * 自动推送的收尾规则：失败计数、自停、以及「成功要把计数清零」。
 *
 * 这些用例存在的理由很具体：失败计数如果只加不清，一次网络抖动就能让
 * 自动推送永久躺平；只清不加，断网时会一夜推几千次。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, MAX_FAILURES, normalize, decide, afterRun } from '../lib/auto.js';

const base = {
  now: 1_700_000_000_000,
  lastChangeAt: null,
  lastRunAt: null,
  busy: false,
  hasChanges: true,
  hasConflicts: false,
};

test('失败一次计数加一', () => {
  const next = afterRun({ ...DEFAULTS, failures: 0 }, { ok: false, error: 'network down' }, base.now);
  assert.equal(next.failures, 1);
  assert.match(next.lastResult, /network down/);
});

test('成功一次把计数清零', () => {
  const next = afterRun({ ...DEFAULTS, failures: 2 }, { ok: true, committed: 3 }, base.now);
  assert.equal(next.failures, 0);
  assert.match(next.lastResult, /3/);
});

test('计数封顶在 MAX_FAILURES，不会一直涨', () => {
  const next = afterRun({ ...DEFAULTS, failures: MAX_FAILURES }, { ok: false }, base.now);
  assert.equal(next.failures, MAX_FAILURES);
});

test('afterRun 记录的时间可以被 decide 解析回去', () => {
  const next = afterRun({ ...DEFAULTS, failures: 0 }, { ok: true }, base.now);
  assert.equal(Date.parse(next.lastRunAt), base.now);
});

test('连续失败到上限后不再自动推', () => {
  const settings = { ...DEFAULTS, enabled: true, failures: MAX_FAILURES };
  assert.deepEqual(decide({ ...base, settings }), { run: false, reason: 'too-many-failures' });
});

test('失败未达上限仍然会推', () => {
  const settings = { ...DEFAULTS, enabled: true, mode: 'interval', failures: MAX_FAILURES - 1 };
  const verdict = decide({ ...base, settings, lastRunAt: base.now - 2 * 60 * 60 * 1000 });
  assert.equal(verdict.run, true);
  assert.equal(verdict.reason, 'interval');
});

test('有冲突时绝不自动推，哪怕到点了', () => {
  const settings = { ...DEFAULTS, enabled: true, mode: 'interval' };
  const verdict = decide({ ...base, settings, hasConflicts: true });
  assert.deepEqual(verdict, { run: false, reason: 'conflicts' });
});

test('没有改动时返回 clean 而不是报错', () => {
  const settings = { ...DEFAULTS, enabled: true, mode: 'interval' };
  const verdict = decide({ ...base, settings, hasChanges: false });
  assert.deepEqual(verdict, { run: false, reason: 'clean' });
});

test('normalize 保留 failures 并夹在范围内', () => {
  assert.equal(normalize({ failures: 99 }).failures, MAX_FAILURES);
  assert.equal(normalize({ failures: -5 }).failures, 0);
  assert.equal(normalize({ failures: 'x' }).failures, 0);
});

test('normalize(null) 仍然等于默认值（含 failures）', () => {
  assert.deepEqual(normalize(null), DEFAULTS);
});
