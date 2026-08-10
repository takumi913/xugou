/**
 * 版本号工具：语义化版本比较 + GitHub Releases 新版检测
 *
 * 检测节流：localStorage 记录上次请求时间戳，每 24h 才真正请求一次
 * GitHub API，其余时间复用缓存的最新 tag；请求失败静默（纯浏览器 fetch，
 * 不经 Service Worker 预缓存，PWA/CSP 无碍）。
 */

import { GITHUB_REPO } from "../config";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_AT_STORAGE_KEY = "xugou_version_check_at";
const LATEST_TAG_STORAGE_KEY = "xugou_version_latest_tag";
const MAX_VERSION_RESPONSE_BYTES = 64 * 1024;

/**
 * 语义化版本比较（支持 v 前缀与预发布后缀，如 v1.2.3-rc1）。
 * 返回 -1/0/1 表示 a 小于/等于/大于 b；任一版本无法解析时返回 null。
 */
export function compareSemver(a: string, b: string): number | null {
  const identifier = /^[0-9A-Za-z-]+$/;
  const parse = (v: string): { core: string[]; pre: string[] } | null => {
    const trimmed = v.trim().replace(/^[vV]/, "");
    if (!trimmed) return null;
    const buildParts = trimmed.split("+");
    if (buildParts.length > 2) return null;
    if (
      buildParts[1] !== undefined &&
      buildParts[1].split(".").some((item) => !identifier.test(item))
    ) {
      return null;
    }
    const dashIndex = buildParts[0].indexOf("-");
    const base = dashIndex < 0 ? buildParts[0] : buildParts[0].slice(0, dashIndex);
    const preValue = dashIndex < 0 ? undefined : buildParts[0].slice(dashIndex + 1);
    const core = base.split(".");
    if (
      core.length !== 3 ||
      core.some((item) => !/^(0|[1-9]\d*)$/.test(item))
    ) {
      return null;
    }
    const pre = preValue === undefined ? [] : preValue.split(".");
    if (
      pre.some(
        (item) =>
          !identifier.test(item) || (/^\d+$/.test(item) && !/^(0|[1-9]\d*)$/.test(item))
      )
    ) {
      return null;
    }
    return { core, pre };
  };

  const va = parse(a);
  const vb = parse(b);
  if (!va || !vb) return null;

  const compareNumeric = (left: string, right: string) =>
    left.length === right.length
      ? left === right
        ? 0
        : left < right
          ? -1
          : 1
      : left.length < right.length
        ? -1
        : 1;
  for (let i = 0; i < 3; i++) {
    const result = compareNumeric(va.core[i], vb.core[i]);
    if (result !== 0) return result;
  }
  if (va.pre.length === 0 && vb.pre.length === 0) return 0;
  if (va.pre.length === 0) return 1;
  if (vb.pre.length === 0) return -1;
  for (let i = 0; i < Math.min(va.pre.length, vb.pre.length); i++) {
    const leftNumeric = /^\d+$/.test(va.pre[i]);
    const rightNumeric = /^\d+$/.test(vb.pre[i]);
    if (leftNumeric && !rightNumeric) return -1;
    if (!leftNumeric && rightNumeric) return 1;
    let result: number;
    if (leftNumeric) {
      result = compareNumeric(va.pre[i], vb.pre[i]);
    } else {
      const leftNatural = /^(.+?)(\d+)$/.exec(va.pre[i]);
      const rightNatural = /^(.+?)(\d+)$/.exec(vb.pre[i]);
      result =
        leftNatural && rightNatural && leftNatural[1] === rightNatural[1]
          ? compareNumeric(
              leftNatural[2].replace(/^0+(?=\d)/, ""),
              rightNatural[2].replace(/^0+(?=\d)/, "")
            )
          : va.pre[i] === vb.pre[i]
            ? 0
            : va.pre[i] < vb.pre[i]
              ? -1
              : 1;
    }
    if (result !== 0) return result;
  }
  return va.pre.length === vb.pre.length ? 0 : va.pre.length < vb.pre.length ? -1 : 1;
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage 不可用时静默（仅失去节流，不影响功能）
  }
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes: number
): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        return text + decoder.decode();
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 检查是否有比 currentVersion 更新的发布版本。
 * 有新版返回其 tag（如 "v1.2.0"），无新版或检测失败返回 null。
 */
export async function checkForNewVersion(
  currentVersion: string
): Promise<string | null> {
  let latest = readStorage(LATEST_TAG_STORAGE_KEY);
  const lastCheckAt = Number(readStorage(CHECK_AT_STORAGE_KEY) ?? 0);
  const stale =
    !Number.isFinite(lastCheckAt) ||
    Date.now() - lastCheckAt >= CHECK_INTERVAL_MS;

  if (!latest || stale) {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
        { headers: { Accept: "application/vnd.github+json" } }
      );
      if (!response.ok) return null;
      const contentLength = response.headers.get("content-length");
      if (
        contentLength &&
        (!/^\d+$/.test(contentLength) ||
          Number(contentLength) > MAX_VERSION_RESPONSE_BYTES)
      ) {
        return null;
      }
      const body = await readBoundedResponseText(
        response,
        MAX_VERSION_RESPONSE_BYTES
      );
      if (body === null) return null;
      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch {
        return null;
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return null;
      }
      const tagName = (data as { tag_name?: unknown }).tag_name;
      if (typeof tagName !== "string" || tagName === "") {
        return null;
      }
      latest = tagName;
      writeStorage(CHECK_AT_STORAGE_KEY, String(Date.now()));
      writeStorage(LATEST_TAG_STORAGE_KEY, latest);
    } catch {
      // 网络/CORS 失败静默
      return null;
    }
  }

  if (!latest) return null;
  return compareSemver(currentVersion, latest) === -1 ? latest : null;
}
