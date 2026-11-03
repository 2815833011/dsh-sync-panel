// test/routes-integration.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 状态目录必须隔离：默认落在 ~/.dsh/dsh-sync（工作区外，沙箱下写不进）
const sandbox = await mkdtemp(join(tmpdir(), 'dsh-sync-routes-'));
process.env.DSH_SYNC_STATE_DIR = sandbox;
after(() => rm(sandbox, { recursive: true, force: true }));

// apply() 只依赖 ctx.webServer.register / ctx.effect / ctx.logger，
// 用一个假 ctx 把注册表抓下来，逐条打请求。
const registered = new Map();
const ctx = {
  webServer: {
    register({ path, handler }) {
      registered.set(path, handler);
      return () => registered.delete(path);
    },
  },
  effect(fn) {
    return fn();
  },
  logger: { warn() {}, info() {} },
};

const { apply, MARKER_HEADER } = await import('../index.js');
apply(ctx);

/** 假请求/响应。 */
function call(path, body, { method = 'POST', marker = '1', address = '127.0.0.1' } = {}) {
  const handler = registered.get(path);
  assert.ok(handler, `未注册路由 ${path}`);

  const res = {
    status: 0,
    body: '',
    writeHead(status) { this.status = status; },
    end(text) { this.body = text ?? ''; },
  };

  const req = {
    method,
    headers: marker === null ? {} : { [MARKER_HEADER]: marker },
    socket: { remoteAddress: address },
    resume() {},
    // readJsonBody 监听这三件事
    on(event, fn) {
      if (event === 'data' && body !== undefined) {
        fn(Buffer.from(JSON.stringify(body), 'utf8'));
      }
      if (event === 'end') fn();
      if (event === 'error') { /* 不触发 */ }
      return this;
    },
  };

  return Promise.resolve(handler(req, res)).then(() => ({
    status: res.status,
    json: res.body ? JSON.parse(res.body) : null,
  }));
}

test('注册了全部十四个路由', () => {
  assert.deepEqual(
    [...registered.keys()].sort(),
    [
      '/dsh-sync-panel/auto',
      '/dsh-sync-panel/auto-save',
      '/dsh-sync-panel/conflicts',
      '/dsh-sync-panel/diff',
      '/dsh-sync-panel/export',
      '/dsh-sync-panel/history',
      '/dsh-sync-panel/log',
      '/dsh-sync-panel/pull',
      '/dsh-sync-panel/push',
      '/dsh-sync-panel/repo',
      '/dsh-sync-panel/resolve',
      '/dsh-sync-panel/rollback',
      '/dsh-sync-panel/selection',
      '/dsh-sync-panel/status',
    ],
  );
});

test('缺 marker 头被拒', async () => {
  const r = await call('/dsh-sync-panel/status', { cwd: process.cwd() }, { marker: null });
  assert.equal(r.status, 403);
});

test('非本机来源被拒', async () => {
  const r = await call('/dsh-sync-panel/push', { cwd: process.cwd() }, { address: '10.1.2.3' });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /loopback/);
});

test('非 git 目录报 400 而不是 500', async () => {
  const r = await call('/dsh-sync-panel/status', { cwd: 'C:\\' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /不是 git 仓库/);
});

test('缺 cwd 报 400', async () => {
  const r = await call('/dsh-sync-panel/push', { paths: ['a.md'] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /缺少仓库目录/);
});

test('diff 越界路径被拒', async () => {
  const r = await call('/dsh-sync-panel/diff', { cwd: process.cwd(), path: '../../.ssh/id_rsa' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /不是 git 仓库|越界/);
});

test('selection 只接受布尔值并返回计数', async () => {
  const r = await call('/dsh-sync-panel/selection', {
    selection: { 'a.md': true, 'b.md': 'yes', 'c.md': false, '': true },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.count, 2, '只保留 a.md 与 c.md');
});
