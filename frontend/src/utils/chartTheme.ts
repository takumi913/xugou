import type { ResolvedTheme } from "../providers/ThemeProvider";
import type {
  ChartSeriesColors,
  ChartUiColors,
  ThemeManifest,
} from "../themes";

/**
 * chart.js 主题感知配色
 *
 * 色值来源是当前主题清单（frontend/src/themes/<id>/index.ts 的
 * chart / chartUi 字段）——画布无法解析 var(--xxx)，因此主题必须以
 * 真实色值提供图表配色；本模块只做「清单 + 明暗模式 -> 色值」的选取。
 */

export type ChartColors = ChartSeriesColors;
export type ChartThemeColors = ChartUiColors;

// 按当前主题与解析后的明暗模式取图表数据线色板
export function getChartColors(
  theme: ThemeManifest,
  resolvedTheme: ResolvedTheme
): ChartColors {
  return resolvedTheme === "light" ? theme.chart.light : theme.chart.dark;
}

// 轴/网格/刻度/图例/tooltip 的主题感知颜色
export function getChartTheme(
  theme: ThemeManifest,
  resolvedTheme: ResolvedTheme
): ChartThemeColors {
  return resolvedTheme === "light" ? theme.chartUi.light : theme.chartUi.dark;
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
