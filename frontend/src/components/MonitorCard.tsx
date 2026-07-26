import { useMemo } from "react";
import { monitorStatusColors, statusAccentColor } from "../utils/statusColors";
import { MonitorWithDailyStatsAndStatusHistory } from "../types/monitors";
import { useTranslation } from "react-i18next";
import StatusBar from "./MonitorStatusBar";
import ResponseTimeChart from "./ResponseTimeChart";

interface MonitorCardProps {
  monitor: MonitorWithDailyStatsAndStatusHistory;
}

/**
 * API监控卡片组件（终端条形卡风格）
 * 用于显示单个API监控服务的状态信息
 */
const MonitorCard = ({ monitor }: MonitorCardProps) => {
  const { t } = useTranslation();

  // 状态文本映射
  const statusText: { [key: string]: string } = {
    up: t("monitorCard.status.up"),
    down: t("monitorCard.status.down"),
    pending: t("monitorCard.status.pending"),
  };

  // 获取当前监控的状态
  const currentStatus = monitor.status || "pending";
  const statusColor = statusAccentColor(monitorStatusColors, currentStatus);

  // 最近一天的可用率（取 dailyStats 中日期最新的一条）
  const latestAvailability = useMemo(() => {
    if (!monitor.dailyStats || monitor.dailyStats.length === 0) return null;
    const latest = monitor.dailyStats.reduce((acc, stat) =>
      new Date(stat.date).getTime() > new Date(acc.date).getTime() ? stat : acc
    );
    return latest.availability;
  }, [monitor.dailyStats]);

  return (
    <div className="terminal-card p-4 text-[13px]">
      {/* header：名称 + 状态徽章（徽章跟随名称靠左，右上角留给列表页的操作按钮，
          与 AgentStatusBar 的头部布局保持一致，避免与覆盖按钮重叠） */}
      <div className="mb-2 flex min-w-0 items-center gap-2 pr-24">
        <span style={{ color: statusColor, flexShrink: 0 }}>●</span>
        <span
          className="truncate font-semibold"
          style={{ color: "var(--text-primary)" }}
        >
          {monitor.name}
        </span>
        <span
          className="status-label"
          style={{ color: statusColor, borderColor: statusColor, flexShrink: 0 }}
        >
          {statusText[currentStatus] ?? currentStatus}
        </span>
      </div>

      {/* 响应时间 / 可用率 */}
      <div
        className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs"
        style={{ color: "var(--text-secondary)" }}
      >
        <span>
          {t("monitorCard.responseTime")}:{" "}
          <span style={{ color: "var(--accent-cyan)", fontWeight: 600 }}>
            {monitor.response_time ? `${monitor.response_time}ms` : "-"}
          </span>
        </span>
        {latestAvailability !== null && (
          <span>
            {t("monitor.history.availability")}:{" "}
            <span style={{ color: "var(--accent-green)", fontWeight: 600 }}>
              {latestAvailability.toFixed(2)}%
            </span>
          </span>
        )}
      </div>

      {/* 状态条显示 */}
      <div className="w-full pt-2">
        <StatusBar dailyStats={monitor.dailyStats} />
      </div>

      {/* 响应时间图表 */}
      <div className="w-full pt-2">
        <ResponseTimeChart
          history={monitor.history}
          height={150}
          showTimeLabels={true}
        />
      </div>
    </div>
  );
};

export default MonitorCard;
