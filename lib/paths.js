/**
 * lib/paths.js — 路径安全校验。
 *
 * 前端传来的路径一律当作不可信：必须证明它落在仓库根之内，
 * 否则 `git add -- ../../..` 这类输入会碰仓库外的文件。
 */

import { isAbsolute, relative, resolve } from 'node:path';

/**
 * candidate 是否落在 repoRoot 之内（含根自身）。
 *
 * 用 path.relative 判断而不是 startsWith：后者会把 `/repo-evil` 认成
 * `/repo` 的子路径。
 *
 * @param {string} repoRoot - 仓库根（绝对路径）。
 * @param {string} candidate - 待检查路径。
 * @returns {boolean}
 */
export function isInsideRepo(repoRoot, candidate) {
  if (typeof repoRoot !== 'string' || typeof candidate !== 'string') return false;
  if (!repoRoot || !candidate) return false;

  const root = resolve(repoRoot);
  const target = resolve(root, candidate);
  const rel = relative(root, target);

  // 同一个路径 → relative 返回 ''
  if (rel === '') return true;
  // 跑出仓库 → 以 .. 开头
  if (rel === '..' || rel.startsWith('..' + '/') || rel.startsWith('..' + '\\')) return false;
  // 不同盘符 → relative 返回绝对路径
  if (isAbsolute(rel)) return false;
  return true;
}

/**
 * 反斜杠转正斜杠，用于跨平台比较与显示。
 *
 * @param {string} p
 * @returns {string}
 */
export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}
