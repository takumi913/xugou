import { Box, Flex, Text } from "@/components/ui/theme-shim";
import {
  CheckCircledIcon,
  CrossCircledIcon,
  QuestionMarkCircledIcon,
} from "@radix-ui/react-icons";
import { Card, Badge } from "./ui";
import type { BadgeColor } from "./ui/badge";
import { MonitorWithDailyStatsAndStatusHistory } from "../types/monitors";
import { useTranslation } from "react-i18next";
import StatusBar from "./MonitorStatusBar";
import ResponseTimeChart from "./ResponseTimeChart";

interface MonitorCardProps {
  monitor: MonitorWithDailyStatsAndStatusHistory;
}

/**
 * API监控卡片组件
 * 用于显示单个API监控服务的状态信息
 */
const MonitorCard = ({ monitor }: MonitorCardProps) => {
  const { t } = useTranslation();

  // 状态图标组件
  const StatusIcon = ({ status }: { status: string }) => {
    switch (status) {
      case "up":
        return (
          <CheckCircledIcon width="16" height="16" color="var(--green-9)" />
        );
      case "pending":
        return (
          <QuestionMarkCircledIcon
            width="16"
            height="16"
            color="var(--amber-9)"
          />
        );
      case "down":
      default:
        return <CrossCircledIcon width="16" height="16" color="var(--red-9)" />;
    }
  };

  // 状态颜色映射
  const statusColors: Record<string, BadgeColor> = {
    up: "green",
    down: "red",
    pending: "amber",
  };

  // 状态文本映射
  const statusText: { [key: string]: string } = {
    up: t("monitorCard.status.up"),
    down: t("monitorCard.status.down"),
    pending: t("monitorCard.status.pending"),
  };

  // 获取当前监控的状态
  const currentStatus = monitor.status || "pending";

  return (
    <Card>
      <Flex justify="between" align="start" p="4" gap="2" direction="column">
        <Flex justify="between" align="center" style={{ width: "100%" }}>
          <Flex align="center" gap="2">
            <StatusIcon status={currentStatus} />
            <Text weight="medium">{monitor.name}</Text>
          </Flex>
          <Badge color={statusColors[currentStatus] ?? "gray"}>
            {statusText[currentStatus]}
          </Badge>
        </Flex>

        {/* 状态条显示 */}
        <Box pt="2" style={{ width: "100%" }}>
          <StatusBar dailyStats={monitor.dailyStats} />
        </Box>

        {/* 响应时间图表 */}
        <Box pt="2" style={{ width: "100%" }}>
          <ResponseTimeChart
            history={monitor.history}
            height={150}
            showTimeLabels={true}
          />
        </Box>
      </Flex>
    </Card>
  );
};

export default MonitorCard;
