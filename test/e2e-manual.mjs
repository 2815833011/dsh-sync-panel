/**
 * 端到端验证：在真实仓库上走一遍「推送 → 拉取 → 回滚」。
 *
 * 不走浏览器，但走真实的 HTTP 路由和真实的 git —— 面板按钮点的就是这 12 条
 * 路由里的三条，所以这个脚本验证的东西和用户点按钮时发生的完全一致。
 *
 * 用法：node test/e2e-manual.mjs <仓库目录>
 */
import { createServer } from 'node:http';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { apply } from '../index.js';

const repo = process.argv[2];
if (!repo) {
  console.error('用法: node test/e2e-manual.mjs <仓库目录>');
  process.exit(2);
}

/** 收路由表。 */
const routes = new Map();
const ctx = {
  logger: { warn: (...args) => console.error('[warn]', ...args) },
  effect: (fn) => fn(),
  webServer: {
    register({ path, handler }) {
      routes.set(path, handler);
      return () => routes.delete(path);
    },
  },
};

const server = createServer((req, res) => {
  const handler = routes.get(req.url);
  if (!handler) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'no route' }));
    return;
  }
  void handler(req, res);
});

apply(ctx);

await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;

/** 打一次路由。 */
async function call(action, body) {
  const response = await fetch(`${base}/dsh-sync-panel/${action}`, {
    method: 'POST',
    headers: { 'x-dsh-sync-panel': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: repo, ...body }),
  });
  return { status: response.status, body: await response.json() };
}

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '✔' : '✖'} ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

try {
  // ---- 0. 造一个改动，让推送有东西可推 ----
  const probe = join(repo, 'e2e-probe.md');
  await writeFile(probe, `# e2e 探针\n\n生成于 ${new Date().toISOString()}\n`, 'utf8');

  // ---- 1. status ----
  const before = await call('status', {});
  check('status 返回 200', before.status === 200);
  check('status 列出探针文件', (before.body.changes ?? []).some((c) => c.path === 'e2e-probe.md'));
  check('status 报告分支 main', before.body.branch === 'main', before.body.branch);

  // ---- 2. diff ----
  const diff = await call('diff', { path: 'e2e-probe.md' });
  check('diff 返回 200', diff.status === 200);
  check('diff 里能看到探针内容', String(diff.body.diff ?? '').includes('e2e 探针'));

  // ---- 3. diff 越界被拒 ----
  const bad = await call('diff', { path: '../.ssh/id_rsa' });
  check('越界路径被拒', bad.status === 400, bad.body.error);

  // ---- 4. push ----
  const pushed = await call('push', { paths: ['e2e-probe.md'], message: 'e2e: 验证推送链路' });
  check('push 返回 200', pushed.status === 200, pushed.body.error ?? '');
  check('push 真的提交了', Number(pushed.body.committed ?? 0) === 1);
  const sha = String(pushed.body.sha ?? '');
  check('push 返回短 sha', /^[0-9a-f]{6,}$/.test(sha), sha);

  // ---- 5. 再推一次同样的东西：应当是「没有改动」而不是报错 ----
  const again = await call('push', { paths: ['e2e-probe.md'], message: 'e2e: 重复推送' });
  check('重复推送不报错', again.status === 200);
  check('重复推送报告零提交', Number(again.body.committed ?? 0) === 0, JSON.stringify(again.body));

  // ---- 6. pull：应当「已是最新」，不该失败 ----
  const pulled = await call('pull', {});
  check('pull 返回 200', pulled.status === 200, pulled.body.error ?? '');

  // ---- 7. history 里能看到刚才那条 ----
  const history = await call('history', { count: 5 });
  check('history 里有 e2e 提交', (history.body.commits ?? []).some((c) => String(c.subject).includes('e2e: 验证推送链路')));

  // ---- 8. rollback：对刚提交的那条做 revert ----
  const rolled = await call('rollback', { target: sha });
  check('rollback 返回 200', rolled.status === 200, rolled.body.error ?? '');

  // ---- 9. 回滚之后文件应该没了 ----
  const after = await call('status', {});
  check('回滚后工作区干净', (after.body.changes ?? []).length === 0, JSON.stringify(after.body.changes));

  // ---- 10. log 有记录 ----
  const log = await call('log', {});
  const lines = log.body.lines ?? [];
  check('日志记录了 push', lines.some((l) => l.includes('push') && l.includes('ok')));
  check('日志记录了 rollback', lines.some((l) => l.includes('rollback')));

  // ---- 11. 并发：同一时刻两个请求，第二个必须 409 ----
  const race = await Promise.all([
    call('status', {}),
    call('push', { paths: ['e2e-probe.md'], message: 'e2e: 并发' }),
  ]);
  const codes = race.map((r) => r.status);
  check('并发时至少一个不是 409', codes.includes(200), JSON.stringify(codes));

  // ---- 12. 缺少 marker 头被拒 ----
  const noMarker = await fetch(`${base}/dsh-sync-panel/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: repo }),
  });
  check('缺 marker 头被拒', noMarker.status === 403, String(noMarker.status));

  // ---- 13. GET 被拒 ----
  const getResp = await fetch(`${base}/dsh-sync-panel/status?cwd=${encodeURIComponent(repo)}`, {
    headers: { 'x-dsh-sync-panel': '1' },
  });
  check('GET 被拒', getResp.status === 405, String(getResp.status));
} finally {
  server.close();
  await rm(join(repo, 'e2e-probe.md'), { force: true });
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
