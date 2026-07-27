/**
 * 主题注册表（自动发现，无需手工登记）
 *
 * 通过 Vite import.meta.glob 扫描本目录下的所有主题文件夹：
 *   - ./<id>/theme.css 被 eager 打进主 CSS 包（首帧无闪烁、切换零网络请求）
 *   - ./<id>/index.ts 的默认导出作为主题清单，逐项校验后注册
 *
 * 新增主题只需按 README.md 的规范添加一个文件夹，构建即自动生效。
 */

import {
  THEME_ID_PATTERN,
  type ChartSeriesColors,
  type ChartUiColors,
  type ThemeManifest,
} from "./types";

export * from "./types";

// 主题样式全部随主包加载（体量为纯变量声明，可忽略不计）
import.meta.glob("./*/theme.css", { eager: true });

const manifestModules = import.meta.glob("./*/index.ts", {
  eager: true,
}) as Record<string, { default?: unknown }>;

/** 默认主题：注册表兜底与后端 schema 默认值都指向它，不可删除 */
export const DEFAULT_THEME_ID = "mono";

const CHART_SERIES_KEYS: Array<keyof ChartSeriesColors> = [
  "cpu",
  "memory",
  "disk",
  "netDown",
  "netUp",
  "process",
  "secondary",
];
const CHART_UI_KEYS: Array<keyof ChartUiColors> = [
  "gridColor",
  "tickColor",
  "tooltipBg",
  "tooltipBorder",
  "tooltipTitle",
  "tooltipBody",
];

function hasStringKeys(value: unknown, keys: string[]): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return keys.every(
    (key) => typeof record[key] === "string" && record[key] !== ""
  );
}

// 清单结构校验：字段缺失/类型不符的主题不注册，并在控制台给出原因
function validateManifest(value: unknown, path: string): ThemeManifest | null {
  const fail = (reason: string) => {
    console.warn(`[themes] 忽略无效主题 ${path}: ${reason}`);
    return null;
  };
  if (!value || typeof value !== "object") return fail("默认导出不是对象");
  const m = value as Record<string, unknown>;
  if (typeof m.id !== "string" || !THEME_ID_PATTERN.test(m.id)) {
    return fail("id 缺失或不符合 kebab-case 规范");
  }
  if (typeof m.name !== "string" || !m.name) return fail("name 缺失");
  if (typeof m.description !== "string") return fail("description 缺失");
  if (
    !Array.isArray(m.preview) ||
    m.preview.length === 0 ||
    !m.preview.every((color) => typeof color === "string")
  ) {
    return fail("preview 必须是非空色值数组");
  }
  const chart = m.chart as Record<string, unknown> | undefined;
  if (
    !chart ||
    !hasStringKeys(chart.dark, CHART_SERIES_KEYS) ||
    !hasStringKeys(chart.light, CHART_SERIES_KEYS)
  ) {
    return fail("chart.dark/light 色板不完整");
  }
  const chartUi = m.chartUi as Record<string, unknown> | undefined;
  if (
    !chartUi ||
    !hasStringKeys(chartUi.dark, CHART_UI_KEYS) ||
    !hasStringKeys(chartUi.light, CHART_UI_KEYS)
  ) {
    return fail("chartUi.dark/light 配色不完整");
  }
  return value as ThemeManifest;
}

const registry = new Map<string, ThemeManifest>();

for (const [path, module] of Object.entries(manifestModules)) {
  const folderId = path.match(/^\.\/([^/]+)\/index\.ts$/)?.[1];
  if (!folderId) continue;
  const manifest = validateManifest(module?.default, path);
  if (!manifest) continue;
  if (manifest.id !== folderId) {
    console.warn(
      `[themes] 忽略主题 ${path}: id "${manifest.id}" 与文件夹名 "${folderId}" 不一致`
    );
    continue;
  }
  if (registry.has(manifest.id)) {
    console.warn(`[themes] 忽略重复主题 id: ${manifest.id}`);
    continue;
  }
  registry.set(manifest.id, manifest);
}

if (!registry.has(DEFAULT_THEME_ID)) {
  console.error(`[themes] 默认主题 "${DEFAULT_THEME_ID}" 缺失，主题系统降级`);
}

/** 全部已注册主题（默认主题排最前，其余按 id 排序） */
export const themes: ThemeManifest[] = [...registry.values()].sort((a, b) => {
  if (a.id === DEFAULT_THEME_ID) return -1;
  if (b.id === DEFAULT_THEME_ID) return 1;
  return a.id.localeCompare(b.id);
});

export function isKnownThemeId(id: unknown): id is string {
  return typeof id === "string" && registry.has(id);
}

/** 取主题清单；未知 id 回退默认主题（再兜底注册表首个） */
export function getThemeById(id: string | null | undefined): ThemeManifest {
  if (id && registry.has(id)) return registry.get(id)!;
  return registry.get(DEFAULT_THEME_ID) ?? themes[0];
}
