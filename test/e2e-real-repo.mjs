// test/e2e-real-repo.mjs
//
// 在真实仓库上跑一遍推送链路。
//
// 这个脚本存在的原因：假 git 的单测能证明调用序列对，但证明不了
// 真 git 会成功。之前 104 项测试全绿，真实仓库却卡在「本地有提交、
// 远端没有」，因为 main 从来没设 upstream。测试的假 git 替它把
// 这条分支圆过去了。
//
// 用法：node test/e2e-real-repo.mjs <仓库路径>
import { push, pull, listRecent } from '../lib/ops.js';
import * as git from '../lib/git.js';
import * as state from '../lib/state.js';

const cwd = process.argv[2];
if (!cwd) {
  console.error('用法: node test/e2e-real-repo.mjs <仓库路径>');
  process.exit(2);
}

function line(t) {
  console.log(`\n=== ${t} ===`);
}

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
}

line('仓库状态');
const status = await git.gitStatus(cwd);
console.log(`改动文件 ${status.changes.length} 个${status.ok ? '' : `（检测失败：${status.error}）`}`);
for (const s of status.changes.slice(0, 10)) console.log(`  ${s.status} ${s.path}`);

line('提交历史');
const recent = await listRecent({ cwd, count: 3, git });
for (const r of recent) console.log(`  ${r.sha}  ${r.subject}`);

line('upstream 检测');
const up = await git.runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
console.log(`  code=${up.code} out=${JSON.stringify(up.stdout.trim())} err=${up.stderr.trim()}`);

line('执行推送');
const r = await push({ cwd, paths: status.map((s) => s.path), message: 'e2e: 验证 upstream 修复', git, state });
console.log(`  ${JSON.stringify(r)}`);
check('推送返回 ok', r.ok === true, `ok=${r.ok}`);
check('不是半成功', !r.localOnly, `localOnly=${r.localOnly}`);

line('远端核对');
const local = await git.runGit(cwd, ['rev-parse', 'HEAD']);
const remote = await git.runGit(cwd, ['rev-parse', 'origin/main']);
console.log(`  local  ${local.stdout.trim()}`);
console.log(`  remote ${remote.stdout.trim()}`);
check('远端 sha 与本地一致', local.stdout.trim() === remote.stdout.trim());

const fails = results.filter((x) => !x.pass);
console.log(`\n结果: ${results.length - fails.length}/${results.length} 通过`);
process.exit(fails.length ? 1 : 0);
