import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, Flex, Heading, Text, Grid } from "@/components/ui/layout";

import { Button, Card, Badge } from "@/components/ui";

import {
  ArrowLeftIcon,
  Pencil1Icon,
  Cross2Icon,
  ReloadIcon,
  ClockIcon,
  InfoCircledIcon,
  LapTimerIcon,
  DesktopIcon,
  GlobeIcon,
  Link2Icon,
  PersonIcon,
  LayersIcon,
  Share1Icon,
  BarChartIcon,
  ActivityLogIcon,
} from "@radix-ui/react-icons";
import {
  getAgent,
  deleteAgent,
  getAgentMetrics,
  getLatestAgentMetrics,
  getAgentCredentials,
  rotateAgentCredential,
  revokeAgentCredential,
  type AgentCredentialMetadata,
} from "../../api/agents";
import { Agent, MetricHistory } from "../../types/agents";
import { useTranslation } from "react-i18next";
import AgentCard from "../../components/AgentCard";
import { toast } from "sonner"; // Added
import { agentStatusColors, getUsageColor } from "../../utils/statusColors";
import { createLiveSocket } from "../../utils/liveSocket";
import LiveIndicator from "../../components/LiveIndicator";
import { formatBytes, formatSpeed } from "../../utils/format";
import {
  memoryPercent as deriveMemoryPercent,
  mergeLatestMetric,
  monthlyTraffic,
  parseDiskUsage,
  trafficPercent,
} from "../../utils/metrics";

// 纯 CSS 环形进度（--ring-value/--ring-color 为合理的动态值内联注入）
const MetricRing = ({
  label,
  percent,
  subtext,
}: {
  label: string;
  percent: number;
  subtext?: string;
}) => {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className="metric-ring-item">
      <div
        className="metric-ring-chart"
        style={
          {
            "--ring-value": `${clamped}`,
            "--ring-color": getUsageColor(clamped),
          } as CSSProperties
        }
      >
        <span className="metric-ring-track" />
        <span className="metric-ring-progress" />
        <span className="metric-ring-center">{Math.round(clamped)}%</span>
      </div>
      <div className="metric-ring-label">{label}</div>
      <div className="metric-ring-subtext">{subtext}</div>
    </div>
  );
};

const AgentDetail = () => {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [issuedCredential, setIssuedCredential] = useState<string | null>(null);
  const [credentialCursor, setCredentialCursor] = useState<number | undefined>();
  const [credentialCursorHistory, setCredentialCursorHistory] = useState<
    Array<number | undefined>
  >([]);
  const [liveMetric, setLiveMetric] = useState<Partial<MetricHistory> | null>(
    null
  );
  const [liveConnected, setLiveConnected] = useState(false);
  // 最近一次 WS 样本的回放滞后（秒），>2s 时 LiveIndicator 显示 (+Ns)
  const [liveLagSeconds, setLiveLagSeconds] = useState(0);
  const { t } = useTranslation();

  const agentId = Number(id);
  const hasValidAgentId = Boolean(id) && !Number.isNaN(agentId);

  useEffect(() => {
    setCredentialCursor(undefined);
    setCredentialCursorHistory([]);
    setIssuedCredential(null);
  }, [agentId]);

  // WebSocket 实时链路：只订阅当前 agent，实时更新环形进度与最新指标
  useEffect(() => {
    if (!hasValidAgentId) return;
    setLiveMetric(null);
    const socket = createLiveSocket({
      subscribe: agentId,
      onUpdate: ({ agentId: updatedId, data, lagSeconds }) => {
        if (updatedId !== agentId) return;
        setLiveMetric((prev) => ({ ...prev, ...data }));
        setLiveLagSeconds(lagSeconds);
      },
      onStatusChange: ({ connected }) => setLiveConnected(connected),
    });
    return () => socket.close();
  }, [agentId, hasValidAgentId]);

  const agentQuery = useQuery({
    queryKey: ["agents", "detail", agentId],
    enabled: hasValidAgentId,
    queryFn: async ({ signal }) => {
      const [view, metrics, latest] = await Promise.all([
        getAgent(agentId, signal),
        getAgentMetrics(agentId, signal),
        getLatestAgentMetrics(agentId, signal).catch(() => null),
      ]);
      const legacyView: Agent = {
        ...view,
        status: view.status === "active" ? "active" : "inactive",
        hostname: view.hostname ?? undefined,
        ip_addresses: JSON.stringify(view.ip_addresses),
        os: view.os ?? undefined,
        version: view.version ?? undefined,
        collect_interval: view.collect_interval_seconds,
        report_interval: view.report_interval_seconds,
        auto_renewal: view.auto_renewal ? 1 : 0,
        is_hidden: view.is_hidden ? 1 : 0,
        auto_update: view.auto_update ? 1 : 0,
        tags: view.tags.join(","),
        billing_cycle: view.billing_cycle as Agent["billing_cycle"],
        traffic_calc_type:
          view.traffic_calc_type as Agent["traffic_calc_type"],
        metrics: metrics.map((metric) => ({ ...metric, id: metric.id ?? 0 })),
      };
      return {
        agent: legacyView,
        latest: latest ? { ...latest, id: latest.id ?? 0 } : null,
      };
    },
    refetchInterval: liveConnected ? 300_000 : 60_000,
  });
  const agent = agentQuery.data?.agent ?? null;
  const loading = agentQuery.isPending;
  const error = agentQuery.error;

  useEffect(() => {
    const restLatest = agentQuery.data?.latest;
    if (restLatest) {
      setLiveMetric((previous) =>
        mergeLatestMetric(previous, restLatest) ?? previous
      );
    }
  }, [agentQuery.data?.latest]);

  const credentialsQuery = useQuery({
    queryKey: ["agents", "credentials", agentId, credentialCursor],
    queryFn: () =>
      getAgentCredentials(agentId, { cursor: credentialCursor, limit: 25 }),
    enabled: hasValidAgentId,
  });
  const credentials: AgentCredentialMetadata[] =
    credentialsQuery.data?.data ?? [];
  const activeCredentialCount = credentials.filter(
    (credential) => !credential.revoked_at
  ).length;

  const rotateCredentialMutation = useMutation({
    mutationFn: () => rotateAgentCredential(agentId),
    onSuccess: (result) => {
      setIssuedCredential(result.token);
      queryClient.invalidateQueries({ queryKey: ["agents", "credentials", agentId] });
      toast.success(t("agent.credentials.rotateSuccess"));
    },
    onError: () => toast.error(t("agent.credentials.rotateError")),
  });

  const revokeCredentialMutation = useMutation({
    mutationFn: (credentialId: number) =>
      revokeAgentCredential(agentId, credentialId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents", "credentials", agentId] });
      toast.success(t("agent.credentials.revokeSuccess"));
    },
    onError: () => toast.error(t("agent.credentials.revokeError")),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteAgent(agentId),
    onSuccess: () => {
      toast.success(t("agent.deleteSuccess"));
      queryClient.removeQueries({ queryKey: ["agents", "detail", agentId] });
      navigate("/agents");
    },
    onError: () => toast.error(t("agent.deleteError")),
  });

  const credentialLoading =
    rotateCredentialMutation.isPending || revokeCredentialMutation.isPending;

  const handleRefresh = () => {
    agentQuery.refetch();
    credentialsQuery.refetch();
  };

  const handleCredentialRotate = () => {
    if (!confirm(t("agent.credentials.rotateConfirm"))) return;
    rotateCredentialMutation.mutate();
  };

  const handleCredentialRevoke = (credentialId: number) => {
    if (!confirm(t("agent.credentials.revokeConfirm"))) return;
    revokeCredentialMutation.mutate(credentialId);
  };

  const handleCredentialNextPage = () => {
    const nextCursor = Number(credentialsQuery.data?.next_cursor);
    if (!Number.isSafeInteger(nextCursor) || nextCursor <= 0) return;
    setCredentialCursorHistory((history) => [...history, credentialCursor]);
    setCredentialCursor(nextCursor);
  };

  const handleCredentialPreviousPage = () => {
    setCredentialCursorHistory((history) => {
      if (history.length === 0) return history;
      setCredentialCursor(history.at(-1));
      return history.slice(0, -1);
    });
  };

  // 取历史数据里时间戳最新的一条指标（仅依赖 agent?.metrics，实时样本变化不重算）
  const historyLatest = useMemo<MetricHistory | undefined>(() => {
    const metrics: MetricHistory[] | undefined = agent?.metrics;
    if (!metrics || metrics.length === 0) return undefined;
    return metrics.reduce((latest, item) =>
      new Date(item.timestamp).getTime() > new Date(latest.timestamp).getTime()
        ? item
        : latest
    );
  }, [agent?.metrics]);

  // 叠加实时样本（供顶部环形进度使用），带时间戳仲裁避免旧样本覆盖新数据
  const latestMetric = useMemo<MetricHistory | undefined>(() => {
    if (!liveMetric) return historyLatest;
    if (!historyLatest) {
      return {
        id: -1,
        agent_id: agentId,
        ...liveMetric,
        timestamp: liveMetric.timestamp ?? new Date().toISOString(),
      };
    }
    return mergeLatestMetric(historyLatest, liveMetric);
  }, [historyLatest, liveMetric, agentId]);

  // 内存使用率（优先用后端算好的字段，缺失时按 used/total 计算）
  const memoryPercent = deriveMemoryPercent(latestMetric);

  // 聚合磁盘用量（disk_metrics 为 JSON 字符串；依赖字符串本身避免无谓重算）
  const diskMetricsJson = latestMetric?.disk_metrics;
  const diskUsage = useMemo(
    () => parseDiskUsage({ disk_metrics: diskMetricsJson }),
    [diskMetricsJson]
  );

  // 当月流量（按计费方式）与限额百分比、当前速率（与卡片同口径）
  const monthBytes = monthlyTraffic(latestMetric, agent?.traffic_calc_type);
  const monthPct = trafficPercent(monthBytes, agent?.traffic_limit_gb);
  const hasSpeed =
    typeof latestMetric?.network_rx_speed === "number" ||
    typeof latestMetric?.network_tx_speed === "number";

  const formatDuration = (diffMs: number) => {
    const diffSec = Math.floor(diffMs / 1000);
    const days = Math.floor(diffSec / 86400);
    const hours = Math.floor((diffSec % 86400) / 3600);
    const minutes = Math.floor((diffSec % 3600) / 60);

    let result = "";
    if (days > 0) result += `${days}${t("agent.duration.days")} `;
    if (hours > 0 || days > 0) result += `${hours}${t("agent.duration.hours")} `;
    result += `${minutes}${t("agent.duration.minutes")}`;
    return result;
  };

  const formatUptime = (agent: Agent) => {
    // 优先用探针上报的主机启动时间（Unix 秒）计算真实运行时长
    if (agent.boot_time && agent.boot_time > 0) {
      const diffMs = Date.now() - agent.boot_time * 1000;
      if (diffMs > 0) {
        return formatDuration(diffMs);
      }
    }

    // 如果有最后活动时间，计算从创建到最后活动的时间差
    if (agent.updated_at) {
      const lastSeenDate = new Date(agent.updated_at);
      const createdDate = new Date(agent.created_at);
      return formatDuration(lastSeenDate.getTime() - createdDate.getTime());
    }

    // 如果没有活动时间记录，显示 0 分钟
    return `0${t("agent.duration.minutes")}`;
  };

  // 使用agent.updated_at代替last_seen作为上次活动时间
  const formatDateTime = (dateTimeStr: string) => {
    if (!dateTimeStr) return t("common.notFound");
    const date = new Date(dateTimeStr);
    return date.toLocaleString();
  };

  const handleDelete = () => {
    if (!confirm(t("agent.deleteConfirm"))) {
      return;
    }

    deleteMutation.mutate();
  };

  if (!hasValidAgentId) {
    return (
      <Box><Text>{t("agents.notFoundId", { id })}</Text></Box>
    );
  }

  if (loading) {
    return (
      <Box>
        <Flex>
          <Text>{t("agents.loadingDetail")}</Text>
        </Flex>
      </Box>
    );
  }

  if (error) {
    return (
      <Box>
        <Flex>
          <Card>
            <Flex direction="column" align="center" gap="4">
              <Heading size="6">{t("common.loadingError")}</Heading>
              <Text>
                {error instanceof Error ? error.message : t("common.error.fetch")}
              </Text>
              <Button onClick={() => navigate("/agents")}>
                {t("common.backToList")}
              </Button>
            </Flex>
          </Card>
        </Flex>
      </Box>
    );
  }

  if (!agent) {
    return (
      <Box>
        <Flex justify="center" align="center">
          <Card>
            <Flex direction="column" align="center" gap="4">
              <Heading size="6">{t("agents.notFound")}</Heading>
              <Text>{t("agents.notFoundId", { id })}</Text>
              <Button onClick={() => navigate("/agents")}>
                {t("common.backToList")}
              </Button>
            </Flex>
          </Card>
        </Flex>
      </Box>
    );
  }

  return (
    <Box className="page-container">
      <Flex justify="between" align="start" direction={{ initial: "column", sm: "row" }} gap="4">
        <Flex align="center" gap="2">
          <Button variant="secondary" onClick={() => navigate("/agents")}>
            <ArrowLeftIcon />
          </Button>
          <h1 className="prompt-title">{t("agent.details")}</h1>
          <Badge color={agentStatusColors[agent.status || "inactive"] ?? "gray"}>
            {agent.status === "active"
              ? t("agent.status.online")
              : t("agent.status.offline")}
          </Badge>
          <LiveIndicator connected={liveConnected} lagSeconds={liveLagSeconds} />
        </Flex>
        <Flex gap="2">
          <Button
            variant="secondary"
            onClick={handleRefresh}
            disabled={loading}
          >
            <ReloadIcon />
            {t("common.refresh")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => navigate(`/agents/edit/${id}`)}
          >
            <Pencil1Icon />
            {t("agent.edit")}
          </Button>
          <Button
            variant="secondary"
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
          >
            <Cross2Icon />
            {deleteMutation.isPending ? t("common.deleting") : t("agent.delete")}
          </Button>
        </Flex>
      </Flex>
      <Box py="3">
        <Grid columns={{ initial: "1" }} gap="4">
          {/* 顶部环形进度（CPU / 内存 / 磁盘，参照 CF-SM ServerRingCard） */}
          {latestMetric &&
            (latestMetric.cpu_usage !== undefined ||
              memoryPercent !== undefined ||
              diskUsage) && (
              <div className="terminal-card metric-rings">
                {latestMetric.cpu_usage !== undefined && (
                  <MetricRing
                    label="CPU"
                    percent={latestMetric.cpu_usage}
                    subtext={
                      latestMetric.cpu_cores !== undefined
                        ? `${latestMetric.cpu_cores} ${t(
                            "agent.metrics.cpu.cores"
                          )}`
                        : undefined
                    }
                  />
                )}
                {memoryPercent !== undefined && (
                  <MetricRing
                    label="RAM"
                    percent={memoryPercent}
                    subtext={
                      latestMetric.memory_total
                        ? `${formatBytes(
                            latestMetric.memory_used ?? 0
                          )} / ${formatBytes(latestMetric.memory_total)}`
                        : undefined
                    }
                  />
                )}
                {diskUsage && (
                  <MetricRing
                    label="DISK"
                    percent={diskUsage.percent}
                    subtext={`${formatBytes(diskUsage.used)} / ${formatBytes(
                      diskUsage.total
                    )}`}
                  />
                )}
              </div>
            )}

          {/* 系统信息卡片 */}
          <div className="terminal-card p-4">
            <Flex direction="column" gap="2">
              <h2 className="group-title">{t("agent.systemInfo")}</h2>
              <Box>
                <Flex align="center" gap="2">
                  <PersonIcon />
                  <Text as="div" size="2" weight="bold">
                    {t("agents.table.name")}:
                  </Text>
                  <Text as="div" size="2">
                    {agent.name}
                  </Text>
                </Flex>
              </Box>
              <Box>
                <Flex align="center" gap="2">
                  <DesktopIcon />
                  <Text as="div" size="2" weight="bold">
                    {t("agent.os")}:
                  </Text>
                  <Text as="div" size="2">
                    {agent.os || t("common.notFound")}
                  </Text>
                </Flex>
              </Box>

              <Box>
                <Flex align="center" gap="2">
                  <InfoCircledIcon />
                  <Text as="div" size="2" weight="bold">
                    {t("agent.version")}:
                  </Text>
                  <Text as="div" size="2">
                    {agent.version || t("common.notFound")}
                  </Text>
                </Flex>
              </Box>

              <Box>
                <Flex align="center" gap="2">
                  <GlobeIcon />
                  <Text as="div" size="2" weight="bold">
                    {t("agent.hostname")}:
                  </Text>
                  <Text as="div" size="2">
                    {agent.hostname || t("common.notFound")}
                  </Text>
                </Flex>
              </Box>

              <Box>
                <Flex align="center" gap="2">
                  <Link2Icon />
                  <Text as="div" size="2" weight="bold">
                    {t("agent.ipAddress")}:
                  </Text>
                  {agent.ip_addresses ? (
                    (() => {
                      try {
                        const ipArray = JSON.parse(String(agent.ip_addresses));
                        if (Array.isArray(ipArray) && ipArray.length > 0) {
                          return (
                            <Text as="div" size="2">
                              {ipArray[0]}
                              {ipArray.length > 1
                                ? ` (+${ipArray.length - 1})`
                                : ""}
                            </Text>
                          );
                        } else {
                          return (
                            <Text as="div" size="2">
                              {String(agent.ip_addresses)}
                            </Text>
                          );
                        }
                      } catch {
                        return (
                          <Text as="div" size="2">
                            {String(agent.ip_addresses)}
                          </Text>
                        );
                      }
                    })()
                  ) : (
                    <Text as="div" size="2" color="gray">
                      {t("common.unknown")}
                    </Text>
                  )}
                </Flex>
              </Box>

              <Box>
                <Flex align="center" gap="2">
                  <LapTimerIcon />
                  <Text as="div" size="2" weight="bold">
                    {t("agent.uptime")}:
                  </Text>
                  <Text as="div" size="2">
                    {formatUptime(agent)}
                  </Text>
                </Flex>
              </Box>

              <Box>
                <Flex align="center" gap="2">
                  <ClockIcon />
                  <Text as="div" size="2" weight="bold">
                    {t("agent.lastUpdated")}:
                  </Text>
                  <Text as="div" size="2">
                    {formatDateTime(agent.updated_at)}
                  </Text>
                </Flex>
              </Box>

              {typeof latestMetric?.process_count === "number" && (
                <Box>
                  <Flex align="center" gap="2">
                    <LayersIcon />
                    <Text as="div" size="2" weight="bold">
                      {t("agent.processCount")}:
                    </Text>
                    <Text as="div" size="2">
                      {latestMetric.process_count}
                    </Text>
                  </Flex>
                </Box>
              )}

              {(typeof latestMetric?.tcp_connections === "number" ||
                typeof latestMetric?.udp_connections === "number") && (
                <Box>
                  <Flex align="center" gap="2">
                    <Share1Icon />
                    <Text as="div" size="2" weight="bold">
                      {t("agent.connections")}:
                    </Text>
                    <Text as="div" size="2">
                      TCP {latestMetric?.tcp_connections ?? "-"} / UDP{" "}
                      {latestMetric?.udp_connections ?? "-"}
                    </Text>
                  </Flex>
                </Box>
              )}

              {/* 当月流量（按计费方式；有限额时附百分比，色随用量） */}
              {monthBytes !== null && (
                <Box>
                  <Flex align="center" gap="2">
                    <BarChartIcon />
                    <Text as="div" size="2" weight="bold">
                      {t("agent.traffic.monthly")}:
                    </Text>
                    <Text as="div" size="2">
                      {formatBytes(monthBytes, 2)}
                      {monthPct !== null && agent.traffic_limit_gb ? (
                        <>
                          {" / "}
                          {formatBytes(
                            agent.traffic_limit_gb * 1024 * 1024 * 1024,
                            1
                          )}{" "}
                          <span style={{ color: getUsageColor(monthPct) }}>
                            ({monthPct.toFixed(1)}%)
                          </span>
                        </>
                      ) : null}
                    </Text>
                  </Flex>
                </Box>
              )}

              {/* 当前速率（服务端计算的实时网速） */}
              {hasSpeed && (
                <Box>
                  <Flex align="center" gap="2">
                    <ActivityLogIcon />
                    <Text as="div" size="2" weight="bold">
                      {t("agent.traffic.speed")}:
                    </Text>
                    <Text as="div" size="2">
                      <span className="net-down">
                        ↓ {formatSpeed(latestMetric?.network_rx_speed)}
                      </span>{" "}
                      <span className="net-up">
                        ↑ {formatSpeed(latestMetric?.network_tx_speed)}
                      </span>
                    </Text>
                  </Flex>
                </Box>
              )}

              {(latestMetric?.ipv4_reachable != null ||
                latestMetric?.ipv6_reachable != null) && (
                <Box>
                  <Flex align="center" gap="2">
                    <GlobeIcon />
                    <Text as="div" size="2" weight="bold">
                      {t("agent.connectivity")}:
                    </Text>
                    <Flex gap="2">
                      {latestMetric?.ipv4_reachable != null && (
                        <span
                          className="status-label"
                          style={{
                            color:
                              latestMetric.ipv4_reachable === 1
                                ? "var(--accent-green)"
                                : "var(--accent-red)",
                            borderColor:
                              latestMetric.ipv4_reachable === 1
                                ? "var(--accent-green)"
                                : "var(--accent-red)",
                          }}
                        >
                          IPv4 {latestMetric.ipv4_reachable === 1 ? "✓" : "✗"}
                        </span>
                      )}
                      {latestMetric?.ipv6_reachable != null && (
                        <span
                          className="status-label"
                          style={{
                            color:
                              latestMetric.ipv6_reachable === 1
                                ? "var(--accent-green)"
                                : "var(--accent-red)",
                            borderColor:
                              latestMetric.ipv6_reachable === 1
                                ? "var(--accent-green)"
                                : "var(--accent-red)",
                          }}
                        >
                          IPv6 {latestMetric.ipv6_reachable === 1 ? "✓" : "✗"}
                        </span>
                      )}
                    </Flex>
                  </Flex>
                </Box>
              )}

              {/* 如果存在多个IP地址，展示完整列表 */}
              {agent.ip_addresses &&
                (() => {
                  try {
                    const ipArray = JSON.parse(String(agent.ip_addresses));
                    if (Array.isArray(ipArray) && ipArray.length > 1) {
                      return (
                        <Box pl="6" mt="1">
                          <Flex direction="column" gap="1">
                            {ipArray.slice(1).map((ip, index) => (
                              <Text key={index} size="2" color="gray">
                                {ip}
                              </Text>
                            ))}
                          </Flex>
                        </Box>
                      );
                    }
                    return null;
                  } catch {
                    return null;
                  }
                })()}
            </Flex>
          </div>

          <div className="terminal-card p-4">
            <Flex direction="column" gap="3">
              <Flex justify="between" align="center" gap="3">
                <Box>
                  <h2 className="group-title">
                    {t("agent.credentials.title")}
                  </h2>
                  <Text size="2" color="gray">
                    {t("agent.credentials.description")}
                  </Text>
                </Box>
                <Button
                  variant="secondary"
                  onClick={handleCredentialRotate}
                  disabled={credentialLoading || activeCredentialCount >= 5}
                >
                  {t("agent.credentials.rotate")}
                </Button>
              </Flex>

              {issuedCredential && (
                <Box className="rounded-md border border-amber-500/50 p-3">
                  <Text as="div" size="2" weight="bold">
                    {t("agent.credentials.oneTime")}
                  </Text>
                  <Text as="div" size="2" className="break-all font-mono">
                    {issuedCredential}
                  </Text>
                  <Flex gap="2" mt="2">
                    <Button
                      variant="secondary"
                      onClick={async () => {
                        await navigator.clipboard.writeText(issuedCredential);
                        toast.success(t("common.copied"));
                      }}
                    >
                      {t("common.copy")}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => setIssuedCredential(null)}
                    >
                      {t("common.close")}
                    </Button>
                  </Flex>
                </Box>
              )}

              {credentials.map((credential) => (
                <Flex
                  key={credential.id}
                  justify="between"
                  align="center"
                  gap="3"
                  className="rounded-md border p-3"
                >
                  <Box>
                    <Text as="div" size="2" weight="bold">
                      {credential.token_hint}
                    </Text>
                    <Text as="div" size="1" color="gray">
                      {t("agent.credentials.createdAt")}: {formatDateTime(credential.created_at)}
                      {" · "}
                      {t("agent.credentials.lastUsedAt")}: {credential.last_used_at ? formatDateTime(credential.last_used_at) : t("common.notFound")}
                    </Text>
                  </Box>
                  {credential.revoked_at ? (
                    <Badge color="gray">{t("agent.credentials.revoked")}</Badge>
                  ) : (
                    <Button
                      variant="secondary"
                      disabled={credentialLoading}
                      onClick={() => handleCredentialRevoke(credential.id)}
                    >
                      {t("agent.credentials.revoke")}
                    </Button>
                  )}
                </Flex>
              ))}

              <Flex justify="between" align="center" gap="3">
                <Text size="1" color="gray">
                  {t("common.pageItemCount", { count: credentials.length })}
                  {activeCredentialCount >= 5
                    ? ` · ${t("agent.credentials.limitReached")}`
                    : ""}
                </Text>
                <Flex gap="2">
                  <Button
                    variant="secondary"
                    disabled={credentialCursorHistory.length === 0}
                    onClick={handleCredentialPreviousPage}
                  >
                    {t("common.previousPage")}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!credentialsQuery.data?.has_more}
                    onClick={handleCredentialNextPage}
                  >
                    {t("common.nextPage")}
                  </Button>
                </Flex>
              </Flex>
            </Flex>
          </div>

          {/* Agent 资源信息卡片（AgentCard 自带 terminal-card 容器与图表区） */}
          <Box>
            <h2 className="group-title">{t("agent.metrics")}</h2>
            <AgentCard
              agent={agent}
              liveMetric={liveMetric}
              showIpAddress={false}
              showHostname={false}
              showLastUpdated={false}
            ></AgentCard>
          </Box>
        </Grid>
      </Box>
    </Box>
  );
};

export default AgentDetail;
