/**
 * 地区（ISO 3166-1 alpha-2 国家码）展示工具
 * 后端 agents.region 由服务端从 Cloudflare 请求判定（两位国家码）
 */

// 两位国家码 → 区域指示符（Regional Indicator）国旗 emoji；非法/空返回 null
export function regionFlagEmoji(code?: string | null): string | null {
  const label = regionLabel(code);
  if (!label) return null;
  return String.fromCodePoint(
    ...[...label].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)
  );
}

// 规范化地区标签：合法两位字母码返回大写形式，否则返回 null
export function regionLabel(code?: string | null): string | null {
  if (typeof code !== "string") return null;
  const normalized = code.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}
