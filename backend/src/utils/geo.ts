/**
 * 上报来源地理位置（Cloudflare request.cf.latitude/longitude/city/region）规范化。
 * 纯函数，供 Agent Report Processor 落库与契约测试共用。
 */

// 坐标保留 4 位小数（约 11m 精度，城市级展示足够）；
// 上报热路径靠「同一输入 → 同一舍入值」保证与已落库值可做严格相等比较，
// 避免浮点毛刺导致每次上报都触发 UPDATE。
const COORDINATE_DECIMALS = 4;

export interface AgentGeoInput {
  latitude?: string | number | null;
  longitude?: string | number | null;
  city?: string | null;
  regionName?: string | null;
}

export interface NormalizedAgentGeo {
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  region_name: string | null;
}

// 解析并校验单个坐标分量：非法/超界返回 null
function normalizeCoordinate(
  value: string | number | null | undefined,
  max: number
): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(num) || Math.abs(num) > max) return null;
  const factor = 10 ** COORDINATE_DECIMALS;
  return Math.round(num * factor) / factor;
}

// 文本字段：trim 后非空才保留（截断到 128 防脏数据撑爆列）
function normalizeGeoText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 128) : null;
}

/**
 * 规范化 Cloudflare 地理数据：
 * - lat ∈ [-90,90]、lon ∈ [-180,180]，字符串 parseFloat，非法置 null；
 * - 坐标必须成对有效，任一非法则两者都置 null（半个坐标无法定位）；
 * - city / region_name trim 后非空保留。
 */
export function normalizeAgentGeo(
  input: AgentGeoInput | null | undefined
): NormalizedAgentGeo {
  let latitude = normalizeCoordinate(input?.latitude, 90);
  let longitude = normalizeCoordinate(input?.longitude, 180);
  if (latitude === null || longitude === null) {
    latitude = null;
    longitude = null;
  }
  return {
    latitude,
    longitude,
    city: normalizeGeoText(input?.city),
    region_name: normalizeGeoText(input?.regionName),
  };
}
