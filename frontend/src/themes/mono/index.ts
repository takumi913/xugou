import type { ThemeManifest } from "../types";

/**
 * mono — 黑灰简约（默认主题 / 参考实现）
 * 中性灰阶承担全部强调与状态色，红色是唯一的告警彩色。
 */
const theme: ThemeManifest = {
  id: "mono",
  name: "Mono 黑灰简约",
  description: "中性灰阶的极简风格，红色仅用于告警，平时安静、出事醒目。",
  author: "XUGOU",
  version: "1.0.0",
  preview: ["#0c0c0c", "#262626", "#8c8c8c", "#d6d6d6", "#f85149"],
  chart: {
    dark: {
      cpu: "#d6d6d6",
      memory: "#9e9e9e",
      disk: "#757575",
      netDown: "#d6d6d6",
      netUp: "#8a8a8a",
      process: "#b8b8b8",
      secondary: "#6e6e6e",
    },
    light: {
      cpu: "#2e2e2e",
      memory: "#6b6b6b",
      disk: "#999999",
      netDown: "#2e2e2e",
      netUp: "#757575",
      process: "#4a4a4a",
      secondary: "#a3a3a3",
    },
  },
  chartUi: {
    dark: {
      gridColor: "rgba(255, 255, 255, 0.06)",
      tickColor: "#8c8c8c",
      tooltipBg: "#141414",
      tooltipBorder: "#262626",
      tooltipTitle: "#d6d6d6",
      tooltipBody: "#e0e0e0",
    },
    light: {
      gridColor: "rgba(0, 0, 0, 0.08)",
      tickColor: "#616161",
      tooltipBg: "#ffffff",
      tooltipBorder: "#dcdcdc",
      tooltipTitle: "#2e2e2e",
      tooltipBody: "#1f1f1f",
    },
  },
};

export default theme;
