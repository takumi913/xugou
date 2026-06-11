import { Box, Card, Flex, Text } from "@/components/ui/theme-shim";
import { Tabs, TabsContent, TabsList, TabsTrigger, Badge } from "./ui";
import type { BadgeColor } from "./ui/badge";
import { GlobeIcon } from "@radix-ui/react-icons";
import MetricsChart from "./MetricsChart";
import { useTranslation } from "react-i18next";
import { AgentCardProps, MetricType } from "../types";

/**
 * 客户端状态卡片组件
 * 用于显示单个客户端的状态和资源使用情况
 */
const AgentCard = ({
  agent,
  showIpAddress = true,
  showHostname = true,
  showLastUpdated = true,
}: AgentCardProps) => {
  const { t } = useTranslation();

  // 根据status属性判断状态
  const agentStatus = agent.status || "inactive";

  // 状态颜色映射
  const statusColors: Record<string, BadgeColor> = {
    active: "green",
    inactive: "amber",
    connecting: "yellow",
    unknown: "gray",
  };

  // 状态文本映射
  const statusText: { [key: string]: string } = {
    active: t("agentCard.status.active"),
    inactive: t("agentCard.status.inactive"),
    connecting: t("agentCard.status.connecting"),
  };

  // 获取IP地址显示的文本
  const getIpAddressText = () => {
    if (!agent.ip_addresses) return t("common.notFound");
    const ipArray = JSON.parse(String(agent.ip_addresses));
    return Array.isArray(ipArray) && ipArray.length > 0
      ? ipArray[0] + (ipArray.length > 1 ? ` (+${ipArray.length - 1})` : "")
      : String(agent.ip_addresses);
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

  // 定义所有可用的指标类型
  const metricTypes: MetricType[] = [
    "cpu",
    "memory",
    "disk",
    "network",
    "load",
  ];

  return (
    <Card>
      <Flex justify="between" align="center" p="4">
        <Flex direction="column" gap="1">
          <Flex align="center" gap="2">
            <Box
              style={{
                color:
                  agentStatus === "active" ? "var(--green-9)" : "var(--gray-9)",
              }}
            >
              <GlobeIcon width="16" height="16" />
            </Box>
            <Text weight="medium">{agent.name}</Text>
          </Flex>

          {showHostname && agent.hostname && (
            <Text size="1" color="gray">
              {agent.hostname}
            </Text>
          )}

          {showIpAddress && agent.ip_addresses && (
            <Text size="1" color="gray">
              {getIpAddressText()}
            </Text>
          )}
        </Flex>
        {showLastUpdated && agent.updated_at && (
          <Text size="1" color="gray" mt="2" mb="2">
            {t("agent.lastUpdated")}: {formatLastUpdated()}
          </Text>
        )}
        <Badge color={statusColors[agentStatus] ?? "gray"}>
          {statusText[agentStatus] || agentStatus}
        </Badge>
      </Flex>

      <Box p="2" pt="0">
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
      </Box>
    </Card>
  );
};

export default AgentCard;
