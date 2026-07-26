import type { ResolvedTheme } from "../providers/ThemeProvider";

/**
 * CF-SM 图表色板与主题感知配色（chart.js 专用）
 *
 * 注意：这里刻意硬编码 hex 色值而非 CSS 变量——chart.js 画布无法解析
 * var(--xxx)，且透明填充需要基于真实色值计算 rgba。
 */
export const CHART_COLORS = {
  cpu: "#00d4aa",
  memory: "#b392f0",
  disk: "#39d2c0",
  netDown: "#00d4aa",
  netUp: "#4da6ff",
  process: "#f778ba",
  secondary: "#ffb870",
} as const;

export type ChartColors = { [K in keyof typeof CHART_COLORS]: string };

// 浅色主题变体（对应 global.css .light 的 accent 值：
// green #1a7f5a / blue #2563eb / purple #7c3aed / pink #db2777 / yellow #d97706 / cyan #0d9488）
const CHART_COLORS_LIGHT: ChartColors = {
  cpu: "#1a7f5a",
  memory: "#7c3aed",
  disk: "#0d9488",
  netDown: "#1a7f5a",
  netUp: "#2563eb",
  process: "#db2777",
  secondary: "#d97706",
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
    tickColor: isDark ? "#8999af" : "#5c5c5c",
    tooltipBg: isDark ? "#11161f" : "#f8f8f3",
    tooltipBorder: isDark ? "#1e2a3a" : "#d4d4c8",
    tooltipTitle: isDark ? "#00d4aa" : "#1a7f5a",
    tooltipBody: isDark ? "#d3dae3" : "#2c2c2c",
  };
}
