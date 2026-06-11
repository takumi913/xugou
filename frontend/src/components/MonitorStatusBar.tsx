import React, { useMemo, useState } from "react";
import { Box, Text, Flex } from "@/components/ui/theme-shim";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Button,
  Dialog,
  DialogContent,
  DialogTrigger,
  DialogTitle,
  DialogClose,
} from "./ui";
import { useTranslation } from "react-i18next";
import { DailyStats } from "../types/monitors";

// 扩展 DailyStats 类型以匹配 dailyHistory 中的结构
interface EnrichedDailyStats extends DailyStats {
  status: "up" | "down"; // 确保 status 属性存在且类型正确
}

interface StatusBarProps {
  dailyStats?: DailyStats[];
}

/**
 * 状态条组件 - 展示监控状态历史的时间轴格子
 * 每个格子代表一天的数据，最多展示最近30天
 */
const StatusBar: React.FC<StatusBarProps> = ({ dailyStats = [] }) => {
  const { t } = useTranslation();
  const [selectedDayData, setSelectedDayData] =
    useState<EnrichedDailyStats | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // 根据状态或百分比确定颜色
  const getColor = (value: string | number, isHover = false) => {
    // 如果值是百分比字符串，转换为数字
    const numValue =
      typeof value === "string"
        ? parseFloat(value)
        : typeof value === "number"
        ? value
        : 0;

    // 根据状态或百分比确定颜色
    if (typeof value === "string") {
      switch (value) {
        case "up":
          return isHover ? "var(--green-6)" : "var(--green-5)";
        case "down":
          return isHover ? "var(--red-6)" : "var(--red-5)";
        default:
          return isHover ? "var(--gray-6)" : "var(--gray-5)";
      }
    } else {
      // 根据百分比确定颜色
      if (numValue >= 99) {
        return isHover ? "var(--green-6)" : "var(--green-5)";
      } else if (numValue >= 95) {
        return isHover ? "var(--yellow-6)" : "var(--yellow-5)";
      } else if (numValue >= 90) {
        return isHover ? "var(--orange-6)" : "var(--orange-5)";
      } else {
        return isHover ? "var(--red-6)" : "var(--red-5)";
      }
    }
  };

  // 按天聚合数据 - 优先使用每日统计数据，如果没有则使用历史记录
  const dailyHistory = useMemo(() => {
    // 如果有每日统计数据，优先使用
    if (dailyStats && dailyStats.length > 0) {
      return dailyStats.map((stat) => {
        // 确定每天的主要状态
        const dailyStatus =
          stat.up_checks > stat.down_checks
            ? ("up" as const)
            : ("down" as const);

        return {
          ...stat, // 包含所有原始 stat 属性
          status: dailyStatus, // 覆盖或添加 status
        } as EnrichedDailyStats; // 类型断言
      });
    }
    return []; // 如果没有 dailyStats，返回空数组
  }, [dailyStats]);

  const handleDayClick = (data: EnrichedDailyStats) => {
    setSelectedDayData(data);
    setIsModalOpen(true);
  };

  return (
    <>
      {/* 状态历史条 - 使用Grid布局代替Flex */}
      <Box
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${dailyHistory?.length}, 1fr)`,
          gap: "4px",
          width: "100%",
        }}
      >
        {dailyHistory?.map((dayData) => {
          // 确保 dayData 和 monitor_id 存在
          const key =
            dayData && dayData.monitor_id
              ? `${dayData.monitor_id}-${dayData.date}-${Math.random()}`
              : `day-${dayData?.date}-${Math.random()}`;
          return (
            <Tooltip key={key}>
              <TooltipContent>
                <>
                  <Text as="span" size="1" mb="1">
                    {t("common.date")}:{" "}
                    {new Date(dayData.date).toLocaleDateString()}
                  </Text>
                  <br></br>
                  <Text as="span" size="1" mb="1">
                    {t("common.status")}:{" "}
                    {dayData.status === "up"
                      ? t("monitor.status.normal")
                      : dayData.status === "down"
                      ? t("monitor.status.failure")
                      : t("monitor.status.pending")}
                  </Text>
                  <br></br>
                  <Text as="span" size="1" mb="1">
                    {t("monitor.history.availability")}:{" "}
                    {dayData.availability.toFixed(2)}%
                  </Text>
                </>
              </TooltipContent>
              <TooltipTrigger>
                <Box
                  style={{
                    width: "100%",
                    height: "50px",
                    backgroundColor: getColor(dayData.status),
                    borderRadius: "2px",
                    transition: "background-color 0.2s",
                    cursor: "pointer",
                    padding: "0",
                  }}
                  onClick={() => handleDayClick(dayData)}
                />
              </TooltipTrigger>
            </Tooltip>
          );
        })}
      </Box>

      {selectedDayData && (
        <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
          <DialogTrigger />
          <DialogContent style={{ maxWidth: 450 }}>
            <DialogTitle>
              {t(
                `📅 ${new Date(selectedDayData.date).toLocaleDateString()} ${t(
                  "common.status"
                )}: ${
                  selectedDayData.status === "up"
                    ? t("monitor.status.normal")
                    : t("monitor.status.failure")
                }`
              )}
            </DialogTitle>

            <Flex direction="column" gap="3">
              <Text as="div" size="2">
                <strong>{t("monitor.history.availability")}:</strong>{" "}
                {selectedDayData.availability.toFixed(2)}%
              </Text>
              <Text as="div" size="2">
                <strong>{t("monitor.history.totalChecks")}:</strong>{" "}
                {selectedDayData.total_checks}
              </Text>
              <Text as="div" size="2">
                <strong>{t("monitor.history.upChecks")}:</strong>{" "}
                {selectedDayData.up_checks}
              </Text>
              <Text as="div" size="2">
                <strong>{t("monitor.history.downChecks")}:</strong>{" "}
                {selectedDayData.down_checks}
              </Text>
              <Text as="div" size="2">
                <strong>{t("monitor.history.avgResponseTime")}:</strong>{" "}
                {selectedDayData.avg_response_time?.toFixed(2) ?? "N/A"} ms
              </Text>
              <Text as="div" size="2">
                <strong>{t("monitor.history.minResponseTime")}:</strong>{" "}
                {selectedDayData.min_response_time ?? "N/A"} ms
              </Text>
              <Text as="div" size="2">
                <strong>{t("monitor.history.maxResponseTime")}:</strong>{" "}
                {selectedDayData.max_response_time ?? "N/A"} ms
              </Text>
            </Flex>

            <Flex gap="3" mt="4" justify="end">
              <DialogClose>
                <Button variant="secondary" color="gray">
                  {t("common.close")}
                </Button>
              </DialogClose>
            </Flex>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
};

export default StatusBar;
