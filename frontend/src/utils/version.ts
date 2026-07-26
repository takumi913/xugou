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

/**
 * 语义化版本比较（支持 v 前缀与预发布后缀，如 v1.2.3-rc1）。
 * 返回 -1/0/1 表示 a 小于/等于/大于 b；任一版本无法解析时返回 null。
 */
export function compareSemver(a: string, b: string): number | null {
  const parse = (v: string): { parts: number[]; pre: string } | null => {
    const trimmed = v.trim().replace(/^[vV]/, "");
    if (!trimmed) return null;
    const [base, ...preParts] = trimmed.split("-");
    const parts: number[] = [];
    for (const seg of base.split(".")) {
      if (!/^\d+$/.test(seg)) return null;
      parts.push(Number(seg));
    }
    return { parts, pre: preParts.join("-") };
  };

  const va = parse(a);
  const vb = parse(b);
  if (!va || !vb) return null;

  const len = Math.max(va.parts.length, vb.parts.length);
  for (let i = 0; i < len; i++) {
    const ai = va.parts[i] ?? 0;
    const bi = vb.parts[i] ?? 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }

  if (va.pre === vb.pre) return 0;
  if (va.pre === "") return 1;
  if (vb.pre === "") return -1;
  return va.pre < vb.pre ? -1 : 1;
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
      const data = (await response.json()) as { tag_name?: unknown };
      if (typeof data.tag_name !== "string" || data.tag_name === "") {
        return null;
      }
      latest = data.tag_name;
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
