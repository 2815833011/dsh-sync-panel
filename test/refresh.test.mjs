// test/refresh.test.mjs
//
// 钉死「变更检测不灵敏」的另一半：面板装上来之后**从来不会自己刷新**。
// 用户切回窗口看到的是几分钟前的快照，于是屏幕上写着「没有改动」，
// 而他几分钟前改的文件明明就在那儿。
//
// 这里不碰 React，只测纯逻辑：什么时候该刷、什么时候该按住不动。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(here, '..', 'client.js');

/** 极简 React 替身，只为让 factory 跑起来。 */
function makeReact() {
  const createElement = (type, props, ...children) => ({ type, props, children });
  const hook = (initial) => {
    let value = typeof initial === 'function' ? initial() : initial;
    return [value, (next) => { value = typeof next === 'function' ? next(value) : next; }];
  };
  return {
    createElement,
    useState: hook,
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  };
}

async function loadClient() {
  const source = await readFile(CLIENT, 'utf8');
  let registered = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry) {
          registered = entry;
        },
      },
      localStorage: {
        store: new Map(),
        getItem(key) {
          return this.store.has(key) ? this.store.get(key) : null;
        },
        setItem(key, value) {
          this.store.set(key, value);
        },
      },
      addEventListener() {},
      removeEventListener() {},
    },
    document: {
      documentElement: { lang: 'zh-CN' },
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
      head: { append() {} },
    },
    location: { origin: 'http://127.0.0.1:1317' },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    console,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  if (registered === null) throw new Error('client.js 没有调用 window.__ModuleLoader__.load');
  return registered;
}

/** 拿到测试出口。 */
async function loadExports() {
  const entry = await loadClient();
  return entry.factory(() => makeReact()).__test;
}

// ---------------------------------------------------------------------------

test('切回窗口时要刷新：从「在后台」变成「在前台」', async () => {
  const { shouldRefresh } = await loadExports();

  assert.equal(
    shouldRefresh({ now: 10_000, lastAt: 0, hidden: false }),
    true,
    '用户刚从后台切回来，屏幕上的数字可能已经过期了',
  );
});

test('窗口一直开着、人也没走，就别刷', async () => {
  const { shouldRefresh } = await loadExports();

  assert.equal(
    shouldRefresh({ now: 10_000, lastAt: 9_000, hidden: false }),
    false,
    'focus 和 visibilitychange 常常一起触发，不做去重就是白跑两次 git',
  );
});

test('窗口在后台且不可见时不刷——那是在烧电', async () => {
  const { shouldRefresh } = await loadExports();

  assert.equal(
    shouldRefresh({ now: 10_000, lastAt: 0, hidden: true }),
    false,
    '看不见的面板没必要每 60 秒叫一次 git',
  );
});

test('两次刷新之间有最小间隔，避免事件风暴打爆 git', async () => {
  const { shouldRefresh } = await loadExports();

  assert.equal(
    shouldRefresh({ now: 1_000, lastAt: 0, hidden: false }),
    false,
    '刚刷过 1 秒又要刷，压住',
  );
  assert.equal(
    shouldRefresh({ now: 5_000, lastAt: 0, hidden: false }),
    true,
    '隔了 5 秒，该刷了',
  );
});

// ---------------------------------------------------------------------------
// 接线：attach 之后事件真的挂上去，dispose 之后真的摘掉
// ---------------------------------------------------------------------------

/** 假的 window + document，记录监听器。 */
function makeDom() {
  const listeners = new Map();
  const add = (target) => (type, fn) => {
    const key = `${target}:${type}`;
    if (!listeners.has(key)) listeners.set(key, []);
    listeners.get(key).push(fn);
  };
  const remove = (target) => (type, fn) => {
    const key = `${target}:${type}`;
    const list = listeners.get(key) ?? [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };

  const win = { addEventListener: add('win'), removeEventListener: remove('win') };
  const doc = {
    hidden: false,
    addEventListener: add('doc'),
    removeEventListener: remove('doc'),
  };
  return {
    win,
    doc,
    fire: (target, type) => {
      for (const fn of [...(listeners.get(`${target}:${type}`) ?? [])]) fn();
    },
    count: (target, type) => (listeners.get(`${target}:${type}`) ?? []).length,
  };
}

test('attach 会监听 visibilitychange 与 focus，dispose 后摘干净', async () => {
  const { createAutoRefresh } = await loadExports();
  const dom = makeDom();
  let calls = 0;

  const loop = createAutoRefresh({ refresh: () => { calls += 1; }, now: () => 10_000 });
  const dispose = loop.attach(dom.win, dom.doc);

  assert.equal(dom.count('doc', 'visibilitychange'), 1, '没挂 visibilitychange，切回标签页不会刷新');
  assert.equal(dom.count('win', 'focus'), 1, '没挂 focus，切回窗口不会刷新');

  dispose();
  assert.equal(dom.count('doc', 'visibilitychange'), 0, 'dispose 要摘监听，否则组件卸载后还在跑');
  assert.equal(dom.count('win', 'focus'), 0);
  assert.equal(calls, 0);
});

test('从后台切回来时真的调了 refresh', async () => {
  const { createAutoRefresh } = await loadExports();
  const dom = makeDom();
  let calls = 0;
  let at = 1_000;

  const loop = createAutoRefresh({ refresh: () => { calls += 1; }, now: () => at });
  const dispose = loop.attach(dom.win, dom.doc);
  loop.markSeen();

  dom.doc.hidden = true;
  dom.fire('doc', 'visibilitychange'); // 转后台：不刷
  assert.equal(calls, 0, '后台不该刷');

  at = 10_000;
  dom.doc.hidden = false;
  dom.fire('doc', 'visibilitychange'); // 切回前台：刷
  assert.equal(calls, 1, '从后台切回前台应该刷新一次');

  dispose();
});

test('面板在后台时定时器也不许刷', async () => {
  const { createAutoRefresh } = await loadExports();
  const dom = makeDom();
  let calls = 0;
  let at = 1_000;

  const loop = createAutoRefresh({ refresh: () => { calls += 1; }, now: () => at });
  loop.attach(dom.win, dom.doc);
  loop.markSeen();

  at = 100_000;
  dom.doc.hidden = true;
  loop.tick();
  assert.equal(calls, 0, '后台 tick 必须什么都不做');

  dom.doc.hidden = false;
  loop.tick();
  assert.equal(calls, 1, '前台 tick 应该刷新');
});
