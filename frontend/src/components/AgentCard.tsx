import { useMemo } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui";
import { agentStatusColors, statusAccentColor } from "../utils/statusColors";
import { GlobeIcon } from "@radix-ui/react-icons";
import MetricsChart from "./MetricsChart";
import StatBar from "./StatBar";
import { useTranslation } from "react-i18next";
import type { Agent, MetricHistory, MetricType } from "../types";
import type { PingResult } from "../types/agents";
import {
  BILLING_CYCLE_KEYS,
  getDaysUntilExpire,
  getExpireColor,
} from "../utils/billing";
import { formatBytes, formatSpeed } from "../utils/format";
import {
  memoryPercent as deriveMemoryPercent,
  mergeLatestMetric,
  monthlyTraffic,
  parseDiskUsage,
  trafficPercent,
} from "../utils/metrics";
import { regionFlagEmoji, regionLabel } from "../utils/region";
import { ProgressBar } from "./StatBar";

// 四线路拨测面板的固定顺序（参照 CF-SM ServerBarCard CT/CU/CM/BD 四格）
const PING_LINES = [
  { key: "ct", label: "CT" },
  { key: "cu", label: "CU" },
  { key: "cm", label: "CM" },
  { key: "bd", label: "BD" },
] as const;

interface AgentCardProps {
  agent: Agent;
  liveMetric?: Partial<MetricHistory> | null;
  showIpAddress?: boolean;
  showHostname?: boolean;
  showLastUpdated?: boolean;
}

// 延迟着色：<100 绿 / <200 黄 / 其余（含超时）红
const getPingColor = (latencyMs: number | undefined, loss: boolean) => {
  if (loss || typeof latencyMs !== "number" || latencyMs < 0) {
    return "var(--accent-red)";
  }
  if (latencyMs < 100) return "var(--accent-green)";
  if (latencyMs < 200) return "var(--accent-yellow)";
  return "var(--accent-red)";
};

/**
 * 客户端状态卡片组件（终端条形卡风格）
 * 用于显示单个客户端的状态和资源使用情况
 */
const AgentCard = ({
  agent,
  liveMetric,
  showIpAddress = true,
  showHostname = true,
  showLastUpdated = true,
}: AgentCardProps) => {
  const { t } = useTranslation();

  // 根据status属性判断状态
  const agentStatus = agent.status || "inactive";
  const statusColor = statusAccentColor(agentStatusColors, agentStatus);

  // 状态文本映射
  const statusText: { [key: string]: string } = {
    active: t("agentCard.status.active"),
    inactive: t("agentCard.status.inactive"),
    connecting: t("agentCard.status.connecting"),
  };

  // 获取IP地址显示的文本
  const getIpAddressText = () => {
    if (!agent.ip_addresses) return t("common.notFound");
    try {
      const ipArray = JSON.parse(String(agent.ip_addresses));
      return Array.isArray(ipArray) && ipArray.length > 0
        ? ipArray[0] + (ipArray.length > 1 ? ` (+${ipArray.length - 1})` : "")
        : String(agent.ip_addresses);
    } catch {
      return String(agent.ip_addresses);
    }
  };

  // 格式化最后更新时间
  const formatLastUpdated = () => {
    if (!agent.updated_at) return "";

    try {
      return new Date(agent.updated_at).toLocaleString();
    } catch {
      return agent.updated_at;
    }
  };

  // 取时间戳最新的一条指标
  const latestMetric = useMemo<MetricHistory | undefined>(() => {
    const metrics = agent.metrics;
    if (!metrics || metrics.length === 0) return undefined;
    return metrics.reduce((latest, item) =>
      new Date(item.timestamp).getTime() > new Date(latest.timestamp).getTime()
        ? item
        : latest
    );
  }, [agent.metrics]);

  // 叠加实时/最新样本（WS 优先，带时间戳仲裁避免旧样本覆盖新数据）
  const displayMetric = useMemo<Partial<MetricHistory> | undefined>(() => {
    if (!liveMetric) return latestMetric;
    return mergeLatestMetric(latestMetric, liveMetric) ?? undefined;
  }, [latestMetric, liveMetric]);

  // 聚合磁盘用量（disk_metrics 为 JSON 字符串）
  const diskUsage = useMemo(
    () => parseDiskUsage(displayMetric),
    [displayMetric]
  );

  // 内存使用率（优先用后端算好的字段，缺失时按 used/total 计算）
  const memoryPercent = deriveMemoryPercent(displayMetric);

  // SWAP 使用率（无 swap 数据或总量为 0 时不显示）
  const swapPercent =
    displayMetric?.swap_total &&
    displayMetric.swap_total > 0 &&
    typeof displayMetric.swap_used === "number"
      ? (displayMetric.swap_used / displayMetric.swap_total) * 100
      : undefined;

  // 月流量（按计费方式）与限额百分比（无月流量数据时流量行不渲染）
  const monthBytes = monthlyTraffic(displayMetric, agent.traffic_calc_type);
  const trafficPct = trafficPercent(monthBytes, agent.traffic_limit_gb);

  // 四线路拨测结果（ping_json 为 JSON 字符串；无数据时整个面板不渲染）
  const pingItems = useMemo(() => {
    if (!displayMetric?.ping_json) return null;
    try {
      const parsed = JSON.parse(displayMetric.ping_json) as Record<
        string,
        PingResult
      >;
      const items = PING_LINES.filter((line) => parsed[line.key]).map(
        (line) => ({
          label: line.label,
          ...parsed[line.key],
        })
      );
      return items.length > 0 ? items : null;
    } catch {
      return null;
    }
  }, [displayMetric]);

  // 标签徽章（逗号分隔，空项过滤；无标签不渲染）
  const tagItems = useMemo(
    () =>
      (agent.tags ?? "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    [agent.tags]
  );

  // 账单 meta：💰价格/周期 + 📅剩余天数（无数据不显示）
  const priceText =
    typeof agent.price === "number" && agent.price >= 0
      ? `${agent.price}${agent.currency ? ` ${agent.currency}` : ""}${
          agent.billing_cycle
            ? `/${t(BILLING_CYCLE_KEYS[agent.billing_cycle])}`
            : ""
        }`
      : null;
  const expireDays = getDaysUntilExpire(agent.expire_date);

  // 定义所有可用的指标类型
  const metricTypes: MetricType[] = [
    "cpu",
    "memory",
    "disk",
    "network",
    "load",
  ];

  return (
    <div className="terminal-card p-4 text-[13px]">
      {/* header：OS/名称 + 状态徽章 */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <GlobeIcon
              width="16"
              height="16"
              style={{ color: statusColor, flexShrink: 0 }}
            />
            <span
              className="truncate font-semibold"
              style={{ color: "var(--text-primary)" }}
            >
              {agent.name}
            </span>
            {regionFlagEmoji(agent.region) && (
              <span
                className="shrink-0 text-xs"
                style={{ color: "var(--text-secondary)" }}
                title={regionLabel(agent.region) ?? undefined}
              >
                {regionFlagEmoji(agent.region)} {regionLabel(agent.region)}
              </span>
            )}
            {agent.os && (
              <span
                className="truncate text-xs"
                style={{ color: "var(--text-secondary)" }}
              >
                {agent.os}
              </span>
            )}
          </div>

          {showHostname && agent.hostname && (
            <span
              className="truncate text-xs"
              style={{ color: "var(--text-secondary)" }}
            >
              {agent.hostname}
            </span>
          )}

          {showIpAddress && agent.ip_addresses && (
            <span
              className="truncate text-xs"
              style={{ color: "var(--text-secondary)" }}
            >
              {getIpAddressText()}
            </span>
          )}
        </div>

        <div className="flex flex-col items-end gap-1">
          <span
            className="status-label"
            style={{ color: statusColor, borderColor: statusColor }}
          >
            ● {statusText[agentStatus] || agentStatus}
          </span>
          {showLastUpdated && agent.updated_at && (
            <span
              className="text-xs"
              style={{ color: "var(--text-secondary)" }}
            >
              {t("agent.lastUpdated")}: {formatLastUpdated()}
            </span>
          )}
        </div>
      </div>

      {/* 标签徽章行（终端风格小徽章） */}
      {tagItems.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {tagItems.map((tag) => (
            <span key={tag} className="tag-badge">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* 账单 meta 行：💰价格/周期 + 📅剩余天数（参照 CF-SM card-meta） */}
      {(priceText || expireDays !== null) && (
        <div
          className="card-meta mb-2 flex flex-wrap gap-3 text-xs"
          style={{ color: "var(--text-secondary)" }}
        >
          {priceText && <span>💰 {priceText}</span>}
          {expireDays !== null && (
            <span style={{ color: getExpireColor(expireDays) }}>
              📅{" "}
              {expireDays <= 0
                ? t("agent.billing.expired")
                : t("agent.billing.daysLeft", { days: expireDays })}
            </span>
          )}
        </div>
      )}

      {/* 指标行：CPU/内存/交换/磁盘 进度条 + 负载/网速/流量 */}
      {displayMetric && (
        <div className="mb-2">
          {typeof displayMetric.cpu_usage === "number" && (
            <StatBar label={t("agentCard.metric.cpu")} percent={displayMetric.cpu_usage} />
          )}
          {memoryPercent !== undefined && (
            <StatBar label={t("agentCard.metric.memory")} percent={memoryPercent} />
          )}
          {swapPercent !== undefined && (
            <StatBar label={t("agentCard.metric.swap")} percent={swapPercent} />
          )}
          {diskUsage && (
            <StatBar
              label={t("agentCard.metric.disk")}
              percent={diskUsage.percent}
            />
          )}
          {typeof displayMetric.load_1 === "number" && (
            <div className="stat-row">
              <span className="stat-key">{t("agentCard.metric.load")}</span>
              <span className="net-down">
                {displayMetric.load_1.toFixed(2)}
              </span>
              <span style={{ color: "var(--text-secondary)" }}>
                {displayMetric.load_5?.toFixed(2) ?? "-"}
              </span>
              <span className="net-up">
                {displayMetric.load_15?.toFixed(2) ?? "-"}
              </span>
            </div>
          )}
          {/* 网速：服务端计算的实时速率（WS 样本优先；无速率数据显示 '-'） */}
          <div className="stat-row">
            <span className="stat-key">{t("agentCard.metric.network")}</span>
            <span className="net-down">
              ↓ {formatSpeed(displayMetric.network_rx_speed)}
            </span>
            <span className="net-up">
              ↑ {formatSpeed(displayMetric.network_tx_speed)}
            </span>
          </div>
          {/* 流量：当月用量（按计费方式）；设置限额时叠加进度条 */}
          {monthBytes !== null && (
            <div className="stat-row">
              <span className="stat-key">{t("agentCard.metric.traffic")}</span>
              {trafficPct !== null ? (
                <>
                  <ProgressBar percent={trafficPct} />
                  <span
                    className="stat-value whitespace-nowrap"
                    title={`${trafficPct.toFixed(1)}%`}
                  >
                    {formatBytes(monthBytes, 2)} /{" "}
                    {formatBytes(
                      (agent.traffic_limit_gb ?? 0) * 1024 * 1024 * 1024,
                      1
                    )}
                  </span>
                </>
              ) : (
                <span style={{ color: "var(--text-secondary)" }}>
                  {formatBytes(monthBytes, 2)}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* 指标图表区域 */}
      <Tabs defaultValue="cpu">
        <TabsList>
          {metricTypes.map((type) => (
            <TabsTrigger key={type} value={type}>
              {t(`agent.metrics.${type}.title`) || type.toUpperCase()}
            </TabsTrigger>
          ))}
        </TabsList>

        {metricTypes.map((type) => (
          <TabsContent key={type} value={type}>
            <MetricsChart
              history={agent.metrics}
              metricType={type}
              height={180}
              diskDevice="/"
              networkInterface="en0"
              loadType="1"
            />
          </TabsContent>
        ))}
      </Tabs>

      {/* 底部四线路拨测面板（CT/CU/CM/BD，参照 CF-SM ping-panel） */}
      {pingItems && (
        <div className="ping-panel mt-3">
          {pingItems.map((item) => (
            <div key={item.label} className="ping-item">
              <span className="ping-label">{item.label}</span>
              <span
                className="ping-value"
                style={{ color: getPingColor(item.latency_ms, Boolean(item.loss)) }}
              >
                {item.loss ||
                typeof item.latency_ms !== "number" ||
                item.latency_ms < 0
                  ? "--"
                  : `${Math.round(item.latency_ms)}ms`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default AgentCard;
