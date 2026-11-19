import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const ROOT = 'C:/Users/PC/Documents/dsh-workspace/link-plugins/dsh-sync-panel';
const EXPECTED = 'node --test "test/*.test.mjs"';

function withoutTestContext(env) {
  const copy = { ...env };
  delete copy.NODE_TEST_CONTEXT;
  return copy;
}

// node --test 的默认发现会把 e2e-manual.mjs / e2e-real-repo.mjs 也收进去，
// 它们是手工脚本，必然失败；scripts.test 必须显式限定 *.test.mjs。
test('npm test 只跑 *.test.mjs，且能跑出 100+ 个用例', { skip: process.env.SYNC_PANEL_NESTED === '1' }, () => {
  const pkg = JSON.parse(fs.readFileSync(ROOT + '/package.json', 'utf8'));
  assert.strictEqual(pkg.scripts.test, EXPECTED, `scripts.test 应为 ${EXPECTED}，实际 ${pkg.scripts.test}`);

  const out = execFileSync('node', ['--test', 'test/*.test.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300000,
    // 父进程是 node 测试运行器时会把 NODE_TEST_CONTEXT 传给子进程，
    // 子进程会走内部上报通道、stdout 全空，必须剥掉。
    env: { ...withoutTestContext(process.env), SYNC_PANEL_NESTED: '1' },
  });
  const pass = Number((/pass (\d+)/.exec(out) || [])[1] || 0);
  assert.ok(pass >= 100, `通过用例数应 >= 100，实际 ${pass}；输出：${out.slice(-500)}`);
  assert.doesNotMatch(out, /fail [1-9]/);
});
