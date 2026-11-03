/**
 * client.test.mjs — 在没有浏览器的前提下验证 client.js 的装配。
 *
 * 验的是「模块能不能被宿主正确装载」这一层，不是像素：
 *   - factory 能不能执行完（导入期就抛的插件在浏览器里是白屏，且没有栈）
 *   - 返回值有没有 name / apply / inject
 *   - apply 有没有真的去注册 sidebar.panellist 与 main 两个槽位
 *   - 面板组件能不能渲染成 vnode（不接 React DOM，只调函数体）
 *
 * 用假 React 而不是真 React：真 React 的 createElement 会要求合法组件类型，
 * 而这里要看的恰恰是「我们注册了什么」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(here, '..', 'client.js');

/** 极简 React 替身：createElement 只记录形状。 */
function makeReact() {
  const createElement = (type, props, ...children) => ({ type, props, children });
  const hook = (initial) => {
    let value = typeof initial === 'function' ? initial() : initial;
    return [
      value,
      (next) => {
        value = typeof next === 'function' ? next(value) : next;
      },
    ];
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

/**
 * 在 vm 里跑 client.js，返回它注册到 ModuleLoader 的条目。
 * @returns {{ id: string, factory: Function }}
 */
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
  assert.ok(registered !== null, 'client.js 没有调用 window.__ModuleLoader__.load');
  return registered;
}

test('模块登记了正确的 id', async () => {
  const entry = await loadClient();
  assert.equal(entry.id, 'dsh-sync-panel');
});

test('factory 能执行完并返回 name/apply/inject', async () => {
  const entry = await loadClient();
  const react = makeReact();
  const exports = entry.factory((specifier) => {
    if (specifier === 'react') return react;
    throw new Error(`unexpected require: ${specifier}`);
  });
  assert.equal(typeof exports, 'object');
  assert.equal(exports.name, 'dsh-sync-panel');
  assert.equal(typeof exports.apply, 'function');
  assert.ok(Array.isArray(exports.inject), 'inject 应该是数组');
  assert.ok(exports.inject.includes('slots'));
});

test('apply 向 sidebar.panellist 与 main 各注册一次', async () => {
  const entry = await loadClient();
  const exports = entry.factory(() => makeReact());

  const registrations = [];
  const ctx = {
    effect: (fn) => fn(),
    slots: {
      inject: (_name, fn) => fn(),
      register: (spec, component) => {
        registrations.push({ spec, component });
        return () => {};
      },
    },
    layout: { selectPanel() {} },
  };

  exports.apply(ctx);

  const names = registrations.map((r) => r.spec.name);
  assert.ok(names.includes('sidebar.panellist'), `缺少侧栏注册：${String(names)}`);
  assert.ok(names.includes('main'), `缺少主面板注册：${String(names)}`);

  const pane = registrations.find((r) => r.spec.name === 'sidebar.panellist');
  assert.equal(pane.spec.id, 'sync');
  assert.equal(typeof pane.spec.label, 'function');
  assert.equal(typeof pane.component, 'function');

  const main = registrations.find((r) => r.spec.name === 'main');
  assert.equal(main.spec.key, 'sync');
  assert.equal(typeof main.component, 'function');
});

test('面板组件在无仓库时能渲染出骨架', async () => {
  const entry = await loadClient();
  const exports = entry.factory(() => makeReact());
  let panel = null;
  const ctx = {
    effect: (fn) => fn(),
    slots: {
      inject: (_name, fn) => fn(),
      register: (spec, component) => {
        if (spec.name === 'main') panel = component;
        return () => {};
      },
    },
    layout: { selectPanel() {} },
  };
  exports.apply(ctx);
  assert.ok(panel !== null, '没有拿到主面板组件');

  // 组件函数体应当返回一个可渲染的 vnode，而不是抛错
  const vnode = panel({});
  assert.equal(typeof vnode, 'object');
  assert.equal(vnode.type, 'div');
});

// ---------------------------------------------------------------------------
// 三路对比
// ---------------------------------------------------------------------------

/** 取一个冲突面板可用的 exports。 */
async function loadForMerge() {
  const entry = await loadClient();
  const exports = entry.factory(() => makeReact());
  assert.ok(exports.__test?.MergeView, '__test.MergeView 没导出，测试够不到冲突面板');
  return exports;
}

/** 深挖 vnode 树，把所有满足条件的节点收集起来。 */
function walk(node, hit, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, hit, out);
    return out;
  }
  if (hit(node)) out.push(node);
  // 函数组件在假 React 里不会被自动展开，这里按 React 的方式手动调一次，
  // 否则只测得到最外层，测不到子组件渲染出来的内容。
  const rendered = typeof node.type === 'function' ? node.type(node.props ?? {}) : node;
  const children = Array.isArray(rendered?.children) ? rendered.children : [];
  for (const child of children) walk(child, hit, out);
  return out;
}

/** 造一份 parsed 冲突，形状与 lib/conflicts.js 的 parseConflicts 一致。 */
function fakeFiles() {
  return [
    {
      path: 'a.md',
      hunks: [
        { id: 'h3-0', index: 0, start: 3, end: 9, midAt: 6, baseAt: 4, ours: '我的行', base: '祖先行', theirs: '远端行' },
      ],
    },
  ];
}

test('冲突面板未选满时提交按钮是禁用的', async () => {
  const exports = await loadForMerge();
  const vnode = exports.__test.MergeView({ cwd: 'E:/x', files: fakeFiles(), onClose() {}, onResolved: async () => {} });

  const buttons = walk(vnode, (node) => node.type === 'button');
  const apply = buttons.find((node) => node.children?.includes('应用并提交'));
  assert.ok(apply, '没找到「应用并提交」按钮');
  assert.equal(apply.props.disabled, true, '一处都没选时必须禁用');
});

test('冲突面板把两侧内容与祖先段都渲染出来', async () => {
  const exports = await loadForMerge();
  const vnode = exports.__test.MergeView({ cwd: 'E:/x', files: fakeFiles(), onClose() {}, onResolved: async () => {} });

  const texts = walk(vnode, () => true)
    .flatMap((node) => (Array.isArray(node.children) ? node.children : []))
    .filter((child) => typeof child === 'string');
  assert.ok(texts.includes('我的行'), `缺我的那侧：${JSON.stringify(texts)}`);
  assert.ok(texts.includes('远端行'), `缺远端那侧：${JSON.stringify(texts)}`);
  assert.ok(texts.includes('祖先行'), '祖先段也要在页面上（默认收起但要有）');
});

test('冲突面板无可解析块时给出提示而不是静默空白', async () => {
  const exports = await loadForMerge();
  const files = [{ path: 'bad.md', hunks: [] }];
  const vnode = exports.__test.MergeView({ cwd: 'E:/x', files, onClose() {}, onResolved: async () => {} });
  const texts = walk(vnode, () => true)
    .flatMap((node) => (Array.isArray(node.children) ? node.children : []))
    .filter((child) => typeof child === 'string');
  assert.ok(
    texts.some((text) => text.includes('冲突标记不完整')),
    `应当提示无法解析：${JSON.stringify(texts)}`,
  );
});

test('t() 支持 {n} 占位符替换', async () => {
  const exports = await loadForMerge();
  assert.equal(exports.__test.t('mergeLeft', { n: 3 }), '还有 3 处没选');
  // 没传 vars 时原样返回，不能把花括号吃掉
  assert.equal(exports.__test.t('mergeLeft'), '还有 {n} 处没选');
});

// ---------------------------------------------------------------------------
// 自动推送卡片
// ---------------------------------------------------------------------------

test('自动推送卡片在设置还没拉回来时也不空白', async () => {
  const exports = await loadForMerge();
  const vnode = exports.__test.AutoCard({ cwd: 'E:/x' });
  assert.equal(typeof vnode, 'object');
  assert.equal(vnode.type, 'div');
  assert.equal(vnode.props.className, 'dsp-auto');
});

test('自动推送卡片有开与关两个按钮', async () => {
  const exports = await loadForMerge();
  const vnode = exports.__test.AutoCard({ cwd: 'E:/x' });
  const buttons = walk(vnode, (node) => node.type === 'button');
  // 初始 settings 为 null，只有加载占位，没有开关
  assert.equal(buttons.length, 0, '未拉到设置前不该出现开关，避免点了没反应');
});


// ---------------------------------------------------------------------------
// 主按钮与状态徽标
// ---------------------------------------------------------------------------
//
// 这两样是面板的信息出口：按钮指错方向用户会做错事，徽标说错话用户会信错。
// 它们本来写在组件体里，靠渲染快照才测得到；抽成纯函数后可以直接枚举状态。

test('主按钮：干净且同步时禁用，并且说「已是最新」', async () => {
  const exports = await loadForMerge();
  const d = exports.__test.primaryAction({ busy: '', pendingConflicts: false, ahead: 0, behind: 0, selectedCount: 0 });
  assert.equal(d.kind, 'none');
  assert.equal(d.disabled, true);
  assert.equal(d.label, '已是最新');
});

test('主按钮：有勾选文件时推文件，标签带数量', async () => {
  const exports = await loadForMerge();
  const d = exports.__test.primaryAction({ busy: '', pendingConflicts: false, ahead: 0, behind: 0, selectedCount: 3 });
  assert.equal(d.kind, 'push');
  assert.equal(d.disabled, false);
  assert.equal(d.label, '推送 3 个文件');
});

test('主按钮：工作区干净但欠推时仍可推提交', async () => {
  const exports = await loadForMerge();
  const d = exports.__test.primaryAction({ busy: '', pendingConflicts: false, ahead: 2, behind: 0, selectedCount: 0 });
  assert.equal(d.kind, 'push');
  assert.equal(d.disabled, false, '欠推时按钮必须可点，否则那条提交永远推不上去');
  assert.equal(d.label, '推送 2 个提交');
});

test('主按钮：远端有新提交时即使本地有改动也先拉', async () => {
  const exports = await loadForMerge();
  const d = exports.__test.primaryAction({ busy: '', pendingConflicts: false, ahead: 0, behind: 4, selectedCount: 5 });
  assert.equal(d.kind, 'pull', '先推会被拒，必须引导先拉');
  assert.equal(d.label, '先拉取 4 个提交');
});

test('主按钮：冲突压过一切，因为此时任何写操作都会失败', async () => {
  const exports = await loadForMerge();
  const d = exports.__test.primaryAction({ busy: '', pendingConflicts: true, ahead: 3, behind: 4, selectedCount: 5 });
  assert.equal(d.kind, 'resolve');
  assert.equal(d.disabled, false);
});

test('主按钮：操作进行中一律禁用，且标签变成进行时', async () => {
  const exports = await loadForMerge();
  const d = exports.__test.primaryAction({ busy: 'push', pendingConflicts: false, ahead: 0, behind: 0, selectedCount: 2 });
  assert.equal(d.kind, 'busy');
  assert.equal(d.disabled, true);
  assert.equal(d.label, '推送中…');
});

test('状态徽标：三种「不一样」的状态必须说不同的话', async () => {
  const exports = await loadForMerge();
  const badge = exports.__test.stateBadge;
  const clean = badge({ busy: '', pendingConflicts: false, ahead: 0, behind: 0, changeCount: 0 });
  const dirty = badge({ busy: '', pendingConflicts: false, ahead: 0, behind: 0, changeCount: 2 });
  const unpushed = badge({ busy: '', pendingConflicts: false, ahead: 1, behind: 0, changeCount: 0 });

  assert.equal(clean.cls, 'ok');
  assert.equal(clean.text, '已是最新');
  assert.equal(dirty.text, '2 个文件有改动');
  assert.equal(unpushed.text, '1 个提交没推上去');
  assert.notEqual(clean.text, dirty.text, '干净和「有改动」长得一样，就是这次改造要解决的问题');
  assert.notEqual(clean.text, unpushed.text);
});

test('状态徽标：欠推与落后同时存在时说「两边都有」', async () => {
  const exports = await loadForMerge();
  const b = exports.__test.stateBadge({ busy: '', pendingConflicts: false, ahead: 1, behind: 2, changeCount: 0 });
  assert.equal(b.text, '本地和远端都有新提交');
});
