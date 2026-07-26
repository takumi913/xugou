import type { BadgeColor } from "@/components/ui/badge";

/**
 * 集中的语义色工具：状态/用量 -> 颜色映射
 * 供监控卡片、客户端卡片、列表与详情页统一使用
 */

// 根据资源使用率返回对应的终端主题色（CSS 变量，随明暗主题自动切换）
export function getUsageColor(percentage: number): string {
  if (percentage >= 95) return "var(--accent-red)";
  if (percentage >= 80) return "var(--accent-yellow)";
  if (percentage >= 50) return "var(--accent-blue)";
  return "var(--accent-green)";
}

// 根据可用率百分比返回终端主题色（≥99 绿 / ≥90 黄 / 其余红）
export function getUptimeColor(percentage: number): string {
  if (percentage >= 99) return "var(--accent-green)";
  if (percentage >= 90) return "var(--accent-yellow)";
  return "var(--accent-red)";
}

// API 监控状态 -> Badge 颜色
export const monitorStatusColors: Record<string, BadgeColor> = {
  up: "green",
  down: "red",
  pending: "amber",
};

// 客户端（Agent）状态 -> Badge 颜色
export const agentStatusColors: Record<string, BadgeColor> = {
  active: "green",
  inactive: "red",
  connecting: "yellow",
  unknown: "gray",
};

// Badge 颜色名 -> 终端主题 CSS 变量（仅供 statusAccentColor 内部使用）
const badgeColorToAccent: Record<NonNullable<BadgeColor>, string> = {
  default: "var(--text-primary)",
  green: "var(--accent-green)",
  red: "var(--accent-red)",
  yellow: "var(--accent-yellow)",
  amber: "var(--accent-yellow)",
  gray: "var(--text-secondary)",
};

// 由状态映射表取终端色（未知状态回退为次级文字色）
export function statusAccentColor(
  map: Record<string, BadgeColor>,
  status: string
): string {
  return badgeColorToAccent[map[status] ?? "gray"];
}
