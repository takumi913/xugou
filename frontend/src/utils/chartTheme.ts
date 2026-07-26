import type { ResolvedTheme } from "../providers/ThemeProvider";

/**
 * CF-SM 图表色板与主题感知配色（chart.js 专用）
 *
 * 注意：这里刻意硬编码 hex 色值而非 CSS 变量——chart.js 画布无法解析
 * var(--xxx)，且透明填充需要基于真实色值计算 rgba。
 */
// 黑灰单色简约风：数据线用不同明度的灰阶区分（深色主题亮灰在前）
export const CHART_COLORS = {
  cpu: "#d6d6d6",
  memory: "#9e9e9e",
  disk: "#757575",
  netDown: "#d6d6d6",
  netUp: "#8a8a8a",
  process: "#b8b8b8",
  secondary: "#6e6e6e",
} as const;

export type ChartColors = { [K in keyof typeof CHART_COLORS]: string };

// 浅色主题变体（深灰在前，与 global.css .light 的灰阶方向一致）
const CHART_COLORS_LIGHT: ChartColors = {
  cpu: "#2e2e2e",
  memory: "#6b6b6b",
  disk: "#999999",
  netDown: "#2e2e2e",
  netUp: "#757575",
  process: "#4a4a4a",
  secondary: "#a3a3a3",
};

// 按解析后的主题取图表数据线色板（深色为默认）
export function getChartColors(resolvedTheme: ResolvedTheme): ChartColors {
  return resolvedTheme === "light" ? CHART_COLORS_LIGHT : CHART_COLORS;
}

// 填充透明度（同色低透明度填充）
export const CHART_FILL_ALPHA = 0.12;

// 图表统一等宽字体栈
export const CHART_FONT_FAMILY =
  "'JetBrains Mono', 'Courier New', monospace";

// hex(#rrggbb) -> rgba 字符串，供填充色使用
export function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export interface ChartThemeColors {
  gridColor: string;
  tickColor: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipTitle: string;
  tooltipBody: string;
}

// 轴/网格/刻度/图例/tooltip 的主题感知颜色
export function getChartTheme(resolvedTheme: ResolvedTheme): ChartThemeColors {
  const isDark = resolvedTheme === "dark";
  return {
    gridColor: isDark ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.08)",
    tickColor: isDark ? "#8c8c8c" : "#616161",
    tooltipBg: isDark ? "#141414" : "#ffffff",
    tooltipBorder: isDark ? "#262626" : "#dcdcdc",
    tooltipTitle: isDark ? "#d6d6d6" : "#2e2e2e",
    tooltipBody: isDark ? "#e0e0e0" : "#1f1f1f",
  };
}
