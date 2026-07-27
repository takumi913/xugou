import type { ThemeManifest } from "../types";

/**
 * terminal — 绿色终端风（第二套参考实现）
 * 经典 CRT 终端配色：深蓝黑底 + 荧光绿主强调 + 彩色语义色。
 */
const theme: ThemeManifest = {
  id: "terminal",
  name: "Terminal 绿色终端",
  description: "经典命令行终端风格：荧光绿主色与彩色语义色，信息密度感十足。",
  author: "XUGOU",
  version: "1.0.0",
  preview: ["#0a0e14", "#00d4aa", "#4da6ff", "#ffb870", "#f85149"],
  chart: {
    dark: {
      cpu: "#00d4aa",
      memory: "#b392f0",
      disk: "#39d2c0",
      netDown: "#00d4aa",
      netUp: "#4da6ff",
      process: "#f778ba",
      secondary: "#ffb870",
    },
    light: {
      cpu: "#1a7f5a",
      memory: "#7c3aed",
      disk: "#0d9488",
      netDown: "#1a7f5a",
      netUp: "#2563eb",
      process: "#db2777",
      secondary: "#d97706",
    },
  },
  chartUi: {
    dark: {
      gridColor: "rgba(255, 255, 255, 0.06)",
      tickColor: "#8999af",
      tooltipBg: "#11161f",
      tooltipBorder: "#1e2a3a",
      tooltipTitle: "#00d4aa",
      tooltipBody: "#d3dae3",
    },
    light: {
      gridColor: "rgba(0, 0, 0, 0.08)",
      tickColor: "#5c5c5c",
      tooltipBg: "#f8f8f3",
      tooltipBorder: "#d4d4c8",
      tooltipTitle: "#1a7f5a",
      tooltipBody: "#2c2c2c",
    },
  },
};

export default theme;
