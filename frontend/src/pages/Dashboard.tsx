import { useCallback, useState } from "react";
import { Box, Flex, Heading, Text, Container } from "@/components/ui/theme-shim";
import {
  CheckCircledIcon,
  CrossCircledIcon,
  ClockIcon,
  GlobeIcon,
  ExclamationTriangleIcon,
} from "@radix-ui/react-icons";
import { Monitor, Agent } from "../types";
import { getDashboardDataWithSignal } from "../api/dashboard";
import StatusSummaryCard from "../components/StatusSummaryCard";
import { useTranslation } from "react-i18next";
import { usePolling } from "../hooks/usePolling";

const Dashboard = () => {
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const { t } = useTranslation();

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const dashboardResponse = await getDashboardDataWithSignal(signal);
      if (signal?.aborted) return;

      if (dashboardResponse) {
        setMonitors(dashboardResponse.monitors || []);
        setAgents(dashboardResponse.agents || []);
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, []);

  usePolling(fetchData, {
    intervalMs: 180000,
  });

  // 加载中显示
  if (loading) {
    return (
      <Box className="dashboard-container">
        <Container size="3">
          <Flex justify="center" align="center" style={{ minHeight: "50vh" }}>
            <Text size="3">{t("common.loading")}</Text>
          </Flex>
        </Container>
      </Box>
    );
  }

  // 准备API监控状态摘要数据
  const apiMonitorItems = [
    {
      icon: <CheckCircledIcon width="16" height="16" />,
      label: t("monitors.status.up"),
      value: monitors.filter((m) => m.status === "up").length,
      bgColor: "var(--green-3)",
      iconColor: "var(--green-9)",
    },
    {
      icon: <CrossCircledIcon width="16" height="16" />,
      label: t("monitors.status.down"),
      value: monitors.filter((m) => m.status === "down").length,
      bgColor: "var(--red-3)",
      iconColor: "var(--red-9)",
    },
    {
      icon: <ClockIcon width="16" height="16" />,
      label: t("dashboard.totalMonitors"),
      value: monitors.length,
      bgColor: "var(--gray-3)",
      iconColor: "var(--gray-9)",
    },
  ];

  // 准备客户端状态摘要数据
  const agentStatusItems = [
    {
      icon: <GlobeIcon width="16" height="16" />,
      label: t("agent.status.online"),
      value: agents.filter((a) => a.status === "active").length,
      bgColor: "var(--green-3)",
      iconColor: "var(--green-9)",
    },
    {
      icon: <ExclamationTriangleIcon width="16" height="16" />,
      label: t("agent.status.offline"),
      value: agents.filter((a) => a.status === "inactive").length,
      bgColor: "var(--amber-3)",
      iconColor: "var(--amber-9)",
    },
    {
      icon: <GlobeIcon width="16" height="16" />,
      label: t("dashboard.totalMonitors"),
      value: agents.length,
      bgColor: "var(--gray-3)",
      iconColor: "var(--gray-9)",
    },
  ];

  return (
    <Box>
      <Container size="4">
        <Box>
          {/* 状态摘要 */}
          <Box pb="6">
            <Heading size="6" mb="5">
              {t("dashboard.summary")}
            </Heading>

            <Flex
              gap="4"
              justify="between"
              direction={{ initial: "column", sm: "row" }}
              style={{ width: "100%" }}
            >
              {/* API监控状态摘要 */}
              <Box style={{ flex: 1 }}>
                <StatusSummaryCard
                  title={t("navbar.apiMonitors")}
                  items={apiMonitorItems}
                />
              </Box>

              {/* 客户端监控状态摘要 */}
              <Box style={{ flex: 1 }}>
                <StatusSummaryCard
                  title={t("navbar.agentMonitors")}
                  items={agentStatusItems}
                />
              </Box>
            </Flex>
          </Box>
        </Box>
      </Container>
    </Box>
  );
};

export default Dashboard;
