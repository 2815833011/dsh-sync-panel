/**
 * lib/routes.js — HTTP 层的守卫与响应工具。
 *
 * 三道门，顺序不能换：
 *   1. 方法是 POST（GET 可被 <img src> 触发）
 *   2. 带自定义 marker 头（跨站表单无法设置自定义头 → 挡 CSRF）
 *   3. 来源是本机回环地址
 * 全部通过后才轮到「是否已有任务在跑」——鉴权失败不能被忙碌状态掩盖。
 */

/** 客户端必须带的请求头。 */
export const MARKER_HEADER = 'x-dsh-sync-panel';

/**
 * 对端是否本机。
 * @param {{ socket?: { remoteAddress?: string } }} req
 * @returns {boolean}
 */
export function isLoopback(req) {
  const address = req?.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} body
 */
export function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(text)),
  });
  res.end(text);
}

/**
 * 造一个守卫。守卫本身兼做互斥锁：返回 true 表示「你可以执行了」，
 * 执行完必须调 release()。
 *
 * @returns {((req: object, res: object) => boolean) & { release: () => void, isBusy: () => boolean }}
 */
export function createGuard() {
  let busy = false;

  const guard = (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return false;
    }
    if (req.headers[MARKER_HEADER] !== '1') {
      sendJson(res, 403, { ok: false, error: `missing ${MARKER_HEADER} header` });
      return false;
    }
    if (!isLoopback(req)) {
      sendJson(res, 403, { ok: false, error: 'loopback only' });
      return false;
    }
    req.resume?.();

    if (busy) {
      sendJson(res, 409, { ok: false, error: '已有同步任务正在执行，请等待完成' });
      return false;
    }
    busy = true;
    return true;
  };

  guard.release = () => {
    busy = false;
  };
  guard.isBusy = () => busy;
  /**
   * 不走 HTTP 地拿锁（给定时器用）。
   *
   * 定时推送没有请求也没有响应，但它和面板按钮抢的是同一把锁 ——
   * 两边各拿各的锁就等于没锁，所以必须共用这一个。
   *
   * @returns {boolean} 拿到锁返回 true，拿不到返回 false（不要重试）。
   */
  guard.tryAcquire = () => {
    if (busy) return false;
    busy = true;
    return true;
  };

  return guard;
}

/**
 * 读 JSON 请求体，带字节上限。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<object>}
 */
export function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}
