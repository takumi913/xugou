import { useCallback, useState } from "react";
import { Box, Flex, Heading, Text, Grid, Theme } from "@/components/ui/theme-shim";
import { getPublicAgentMetrics, getStatusPageData } from "../../api/status";
import AgentCard from "../../components/AgentCard";
import MonitorCard from "../../components/MonitorCard";
import AgentStatusBar from "../../components/AgentStatusBar";
import { useTranslation } from "react-i18next";
import {
  MonitorWithDailyStatsAndStatusHistory,
  MetricHistory,
  AgentWithLatestMetrics,
} from "../../types";
import { useParams } from "react-router-dom";
import { usePolling } from "../../hooks/usePolling";

const StatusPage = () => {
  const { t } = useTranslation();
  const { userId } = useParams<{ userId: string }>();
  const [data, setData] = useState<{
    monitors: MonitorWithDailyStatsAndStatusHistory[];
    agents: AgentWithLatestMetrics[];
  }>({
    monitors: [],
    agents: [],
  });
  const [loading, setLoading] = useState(false);
  const [pageTitle, setPageTitle] = useState<string>(t("statusPage.title"));
  const [pageDescription, setPageDescription] = useState<string>(
    t("statusPage.allOperational")
  );
  const [error, setError] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] =
    useState<AgentWithLatestMetrics | null>(null);
  const [selectedAgentMetrics, setSelectedAgentMetrics] = useState<
    MetricHistory[] | null
  >(null);
  const [cardLoading, setCardLoading] = useState(false);

  // 获取数据
  const fetchData = useCallback(async (signal?: AbortSignal) => {
    if (!userId) return;
    setLoading(true);
    try {
      const response = await getStatusPageData(parseInt(userId, 10), signal);
      if (signal?.aborted) return;

      if (response) {
        setPageTitle(response.title || t("statusPage.title"));
        setPageDescription(
          response.description || t("statusPage.allOperational")
        );
        setData({
          monitors: response.monitors || [],
          agents: response.agents || [],
        });
      } else {
        setError(t("statusPage.fetchError"));
      }
    } catch (error) {
      if (!signal?.aborted) {
        setError(
          error instanceof Error ? error.message : t("statusPage.fetchError")
        );
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [t, userId]);

  usePolling(fetchData, {
    enabled: Boolean(userId),
    intervalMs: 180000,
  });

  // 点击 agent 卡片时，获取完整指标
  const handleAgentClick = async (agent: AgentWithLatestMetrics) => {
    if (!userId) return;

    // 如果点击的是当前展开的 agent，则收起
    if (selectedAgent?.id === agent.id) {
      setSelectedAgent(null);
      setSelectedAgentMetrics(null);
      return;
    }

    setSelectedAgent(agent);
    setCardLoading(true);
    setSelectedAgentMetrics(null);
    const metricsRes = await getPublicAgentMetrics(parseInt(userId, 10), agent.id);
    setSelectedAgentMetrics(metricsRes.success ? metricsRes.agent || [] : []);
    setCardLoading(false);
  };

  // 错误显示
  if (error) {
    return (
      <Theme appearance="light">
        <Box>
          <div className="page-container">
            <Flex justify="center" align="center">
              <Text size="3">{error}</Text>
            </Flex>
          </div>
        </Box>
      </Theme>
    );
  }

  if (loading) {
    return (
      <Theme appearance="light">
        <Box>
          <div className="page-container">
            <Flex justify="center" align="center">
              <Text size="3">{t("common.loading")}</Text>
            </Flex>
          </div>
        </Box>
      </Theme>
    );
  }

  return (
    <Theme appearance="light">
      <Box>
        <div className="page-container sm:px-6 lg:px-[8%] px-4">
          {/* 状态页标题区域 */}
          <Flex
            direction="column"
            align="center"
            justify="center"
            py="9"
            gap="5"
          >
            <Heading size="9" align="center">
              {pageTitle}
            </Heading>
            <Text
              size="5"
              align="center"
              className="whitespace-pre-wrap"
            >
              {pageDescription}
            </Text>
          </Flex>

          {/* 客户端监控状态 */}
          {data.agents.length > 0 && (
            <Box py="6">
              <Heading size="5" mb="4">
                {t("statusPage.agentStatus")}
              </Heading>
              <div className="grid grid-cols-1 gap-4">
                {data.agents.map((agent) => (
                  <div key={agent.id}>
                    <div
                      className="cursor-pointer transition hover:scale-[1.01]"
                      onClick={() => handleAgentClick(agent)}
                    >
                      <AgentStatusBar
                        latestMetric={agent.metrics}
                        agent={agent}
                      />
                    </div>
                    {/* 展开的详情区域 */}
                    {selectedAgent?.id === agent.id && (
                      <div className="mt-4">
                        {cardLoading ? (
                          <div className="flex items-center justify-center h-40">
                            <span className="text-lg text-gray-500">
                              {t("common.loading")}
                            </span>
                          </div>
                        ) : (
                          <AgentCard
                            agent={{
                              ...selectedAgent,
                              metrics: selectedAgentMetrics || [],
                            }}
                          />
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Box>
          )}

          {/* API服务状态 */}
          {data.monitors.length > 0 && (
            <Box py="6">
              <Heading size="5" mb="4">
                {t("statusPage.apiServices")}
              </Heading>
              <Grid columns={{ initial: "1" }} gap="4">
                {data.monitors.map((monitor) => (
                  <MonitorCard monitor={monitor} key={monitor.id} />
                ))}
              </Grid>
            </Box>
          )}
        </div>
      </Box>
    </Theme>
  );
};

export default StatusPage;
