// test/paths.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInsideRepo, toPosix } from '../lib/paths.js';

test('isInsideRepo 接受子路径', () => {
  assert.equal(isInsideRepo('/repo', '/repo/skills/a.md'), true);
});

test('isInsideRepo 接受仓库根自身', () => {
  assert.equal(isInsideRepo('/repo', '/repo'), true);
});

test('isInsideRepo 拒绝越界', () => {
  assert.equal(isInsideRepo('/repo', '/repo/../etc/passwd'), false);
  assert.equal(isInsideRepo('/repo', '/other/x'), false);
});

test('isInsideRepo 拒绝前缀伪装', () => {
  assert.equal(isInsideRepo('/repo', '/repo-evil/x'), false);
});

test('toPosix 统一分隔符', () => {
  assert.equal(toPosix('a\\b\\c'), 'a/b/c');
  assert.equal(toPosix('a/b/c'), 'a/b/c');
});
