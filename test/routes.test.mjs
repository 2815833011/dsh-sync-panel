// test/routes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuard, isLoopback } from '../lib/routes.js';

/** 假响应：记录写出的状态码与 body。 */
function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
    },
    end(text) {
      this.body = text ?? '';
    },
  };
}

/** 假请求。 */
function fakeReq({ method = 'POST', marker = '1', address = '127.0.0.1' } = {}) {
  return {
    method,
    headers: marker === null ? {} : { 'x-dsh-sync-panel': marker },
    socket: { remoteAddress: address },
    resume() {},
  };
}

test('isLoopback 识别 127.0.0.1 / ::1 / ::ffff:127.0.0.1', () => {
  assert.equal(isLoopback({ socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '::1' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '192.168.1.5' } }), false);
  assert.equal(isLoopback({ socket: {} }), false);
});

test('guard 拒绝非 POST', () => {
  const guard = createGuard();
  const res = fakeRes();
  const ok = guard(fakeReq({ method: 'GET' }), res);
  assert.equal(ok, false);
  assert.equal(res.status, 405);
});

test('guard 拒绝缺少 marker 头的请求（跨站表单无法设置自定义头）', () => {
  const guard = createGuard();
  const res = fakeRes();
  const ok = guard(fakeReq({ marker: null }), res);
  assert.equal(ok, false);
  assert.equal(res.status, 403);
  assert.match(res.body, /x-dsh-sync-panel/);
});

test('guard 拒绝非本机来源', () => {
  const guard = createGuard();
  const res = fakeRes();
  const ok = guard(fakeReq({ address: '10.0.0.9' }), res);
  assert.equal(ok, false);
  assert.equal(res.status, 403);
  assert.match(res.body, /loopback/);
});

test('guard 放行合法请求', () => {
  const guard = createGuard();
  const res = fakeRes();
  const ok = guard(fakeReq(), res);
  assert.equal(ok, true);
  assert.equal(res.status, 0, '放行时不应写响应');
});

test('guard 忙碌时返回 409，空闲后恢复', () => {
  const guard = createGuard();
  const res1 = fakeRes();
  assert.equal(guard(fakeReq(), res1), true);

  const res2 = fakeRes();
  assert.equal(guard(fakeReq(), res2), false);
  assert.equal(res2.status, 409);
  assert.match(res2.body, /正在执行/);

  guard.release();
  const res3 = fakeRes();
  assert.equal(guard(fakeReq(), res3), true);
});

test('guard 忙碌判断不吞掉鉴权失败（先判鉴权再判忙）', () => {
  const guard = createGuard();
  const res1 = fakeRes();
  assert.equal(guard(fakeReq(), res1), true, '第一次占位成功');

  // 已忙碌时，一个非法请求仍应报 403 而不是 409
  const bad = fakeRes();
  assert.equal(guard(fakeReq({ address: '8.8.8.8' }), bad), false);
  assert.equal(bad.status, 403);
});
