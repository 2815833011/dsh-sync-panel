/**
 * lib/state.js — 面板自己的持久化状态。
 *
 * 三个文件都在 STATE_DIR 下，不进 git：
 *   selection.json  上次勾选了哪些路径
 *   last.json       最近一次操作的结果（sha / 时间 / 动作）
 *   log.txt         追加式操作日志
 *
 * 写入一律「先写 .tmp 再 rename」——中途断电不会留下半个 JSON。
 */

import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 状态目录。环境变量 DSH_SYNC_STATE_DIR 优先，便于测试隔离。
 */
export const STATE_DIR =
  process.env.DSH_SYNC_STATE_DIR || join(homedir(), '.dsh', 'dsh-sync');

const SELECTION = 'selection.json';
const LAST = 'last.json';
const AUTO = 'auto.json';
const REPO = 'repo.json';
const LOG = 'log.txt';

/**
 * 确保状态目录存在。
 * @returns {Promise<void>}
 */
async function ensureDir() {
  await mkdir(STATE_DIR, { recursive: true });
}

/**
 * 原子写一个 JSON 文件。
 * @param {string} name - 文件名。
 * @param {unknown} value - 要序列化的值。
 * @returns {Promise<void>}
 */
async function writeJson(name, value) {
  await ensureDir();
  const final = join(STATE_DIR, name);
  const tmp = final + '.tmp';
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, final);
}

/**
 * 读一个 JSON 文件；不存在或解析失败都返回 fallback。
 * @param {string} name - 文件名。
 * @param {unknown} fallback - 兜底值。
 * @returns {Promise<unknown>}
 */
async function readJson(name, fallback) {
  try {
    const text = await readFile(join(STATE_DIR, name), 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * 读上次勾选结果。
 * @returns {Promise<Record<string, boolean>>}
 */
export async function readSelection() {
  const value = await readJson(SELECTION, {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * 写勾选结果。
 * @param {Record<string, boolean>} sel
 * @returns {Promise<void>}
 */
export async function writeSelection(sel) {
  await writeJson(SELECTION, sel);
}

/**
 * 读最近一次操作记录。
 * @returns {Promise<object|null>}
 */
export async function readLast() {
  const value = await readJson(LAST, null);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * 写最近一次操作记录。
 * @param {object} record
 * @returns {Promise<void>}
 */
export async function writeLast(record) {
  await writeJson(LAST, record);
}

/**
 * 读自动推送设置；没有或坏了都返回空对象，交给 auto.normalize 补默认值。
 *
 * 这里不直接返回 normalize 之后的值：state 层不该知道 auto 层的形状，
 * 否则两边一改就会有一边静默失配。
 *
 * @returns {Promise<object>}
 */
export async function readAuto() {
  const value = await readJson(AUTO, {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * 写自动推送设置。
 * @param {object} settings
 * @returns {Promise<void>}
 */
export async function writeAuto(settings) {
  await writeJson(AUTO, settings);
}

/**
 * 读上次用的仓库目录。
 *
 * 为什么需要这个而不是让前端记在 localStorage 里：DSH 每次重启 web 端口
 * 都变（1317 → 4718 → 8591），而 localStorage 按 origin 隔离。等于每次重启
 * 用户都要重填一遍仓库路径——面板第一步就把人劝退了。
 *
 * @returns {Promise<string>}
 */
export async function readRepo() {
  const value = await readJson(REPO, null);
  return value && typeof value.cwd === 'string' ? value.cwd : '';
}

/**
 * 记住仓库目录。
 * @param {string} cwd
 * @returns {Promise<void>}
 */
export async function writeRepo(cwd) {
  await writeJson(REPO, { cwd: String(cwd ?? '') });
}

/**
 * 追加一行日志（带 ISO 时间戳）。
 * @param {string} line
 * @returns {Promise<void>}
 */
export async function appendLog(line) {
  await ensureDir();
  const stamp = new Date().toISOString();
  const oneLine = String(line).replace(/\r?\n/g, ' ⏎ ');
  await appendFile(join(STATE_DIR, LOG), `${stamp} ${oneLine}\n`, 'utf8');
}

/**
 * 读日志末尾若干行（给面板显示用）。
 * @param {number} [maxLines]
 * @returns {Promise<string[]>}
 */
export async function readLogTail(maxLines = 50) {
  try {
    const text = await readFile(join(STATE_DIR, LOG), 'utf8');
    const lines = text.split('\n').filter(Boolean);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}
