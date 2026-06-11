import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Box, Flex, Heading, Text, Grid, Container } from "@/components/ui/theme-shim";

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
} from "@radix-ui/react-icons";
import { getAgent, deleteAgent, getAgentMetrics } from "../../api/agents";
import { Agent } from "../../types/agents";
import { useTranslation } from "react-i18next";
import AgentCard from "../../components/AgentCard";
import { toast } from "sonner"; // Added
import { usePolling } from "../../hooks/usePolling";

// 定义客户端状态颜色映射
const statusColors: Record<string, "red" | "green" | "yellow" | "gray"> = {
  active: "green",
  inactive: "red",
  connecting: "yellow",
  unknown: "gray",
};

const AgentDetail = () => {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const { t } = useTranslation();

  const agentId = Number(id);
  const hasValidAgentId = Boolean(id) && !Number.isNaN(agentId);

  const fetchAgentData = useCallback(async (signal?: AbortSignal) => {
    if (!hasValidAgentId) return;

    setLoading(true);
    setError(null);
    try {
      const [agentResponse, metricResponse] = await Promise.all([
        getAgent(agentId, signal),
        getAgentMetrics(agentId, signal),
      ]);
      if (signal?.aborted) return;

      if (agentResponse.agent && metricResponse.agent) {
        setAgent({
          ...agentResponse.agent,
          metrics: metricResponse.agent,
        });
      }
    } catch (error) {
      if (!signal?.aborted) {
        setError(
          error instanceof Error ? error.message : t("common.error.fetch")
        );
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [agentId, hasValidAgentId, t]);

  usePolling(fetchAgentData, {
    enabled: hasValidAgentId,
    intervalMs: 60000,
  });

  useEffect(() => {
    if (id && !hasValidAgentId) {
      // 如果id存在但不是有效数字
      console.error(`无效的客户端ID: ${id}`);
      setError(t("agents.notFoundId", { id }));
      setLoading(false);
    }
  }, [hasValidAgentId, id, t]);

  const handleRefresh = () => {
    fetchAgentData();
  };

  const formatUptime = (agent: Agent) => {
    // 如果有最后活动时间，计算从创建到最后活动的时间差
    if (agent.updated_at) {
      const lastSeenDate = new Date(agent.updated_at);
      const createdDate = new Date(agent.created_at);
      const diffMs = lastSeenDate.getTime() - createdDate.getTime();

      // 转换为天、小时、分钟
      const diffSec = Math.floor(diffMs / 1000);
      const days = Math.floor(diffSec / 86400);
      const hours = Math.floor((diffSec % 86400) / 3600);
      const minutes = Math.floor((diffSec % 3600) / 60);

      let result = "";
      if (days > 0) result += `${days}天 `;
      if (hours > 0 || days > 0) result += `${hours}小时 `;
      result += `${minutes}分钟`;

      return result;
    }

    // 如果没有活动时间记录，显示0小时
    return "0小时";
  };

  // 使用agent.updated_at代替last_seen作为上次活动时间
  const formatDateTime = (dateTimeStr: string) => {
    if (!dateTimeStr) return t("common.notFound");
    const date = new Date(dateTimeStr);
    return date.toLocaleString();
  };

  const handleDelete = async () => {
    if (!confirm(t("agent.deleteConfirm"))) {
      return;
    }

    try {
      setDeleteLoading(true);
      toast.loading(t("agent.deleting")); // Added

      const response = await deleteAgent(Number(id));

      if (response.success) {
        toast.success(t("agent.deleteSuccess"));
        setTimeout(() => {
          navigate("/agents");
        }, 3000);
      } else {
        toast.error(response.message || t("agent.deleteError"));
      }
    } catch (error) {
      console.error("删除客户端失败:", error);
      toast.error(t("agent.deleteError"));
    } finally {
      setDeleteLoading(false);
    }
  };

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
              <Text>{error}</Text>
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
    <Container size="4">
      <Flex justify="between" align="start" direction={{ initial: "column", sm: "row" }} gap="4">
        <Flex align="center" gap="2">
          <Button variant="secondary" onClick={() => navigate("/agents")}>
            <ArrowLeftIcon />
          </Button>
          <Heading size="6">{t("agent.details")}</Heading>
          <Badge color={statusColors[agent.status || "inactive"]}>
            {agent.status === "active"
              ? t("agent.status.online")
              : t("agent.status.offline")}
          </Badge>
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
            disabled={deleteLoading}
          >
            <Cross2Icon />
            {deleteLoading ? t("common.deleting") : t("agent.delete")}
          </Button>
        </Flex>
      </Flex>
      <Box py="3">
        <Grid columns={{ initial: "1" }} gap="4">
          {/* 系统信息卡片 */}
          <Card>
            <Flex direction="column" gap="2" className="ml-4">
              <Heading size="3">{t("agent.systemInfo")}</Heading>
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
          </Card>

          {/* Agent 资源信息卡片 */}
          <Card className="pr-4">
            <Flex direction="column" gap="2" className="ml-4">
              <Heading size="3">{t("agent.metrics")}</Heading>
              <AgentCard
                agent={agent}
                showIpAddress={false}
                showHostname={false}
                showLastUpdated={false}
              ></AgentCard>
            </Flex>
          </Card>
        </Grid>
      </Box>
    </Container>
  );
};

export default AgentDetail;
