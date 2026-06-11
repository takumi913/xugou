import { Box, Flex, Heading, Text } from "@/components/ui/theme-shim";
import { Card } from "./ui";
import { ReactNode } from "react";

interface StatusItem {
  icon: ReactNode;
  label: string;
  value: number;
  bgColor?: string;
  iconColor?: string;
}

interface StatusSummaryCardProps {
  title: string;
  items: StatusItem[];
}

/**
 * 状态摘要卡片组件
 * 用于显示系统状态概览，如正常/异常服务数量等
 */
const StatusSummaryCard = ({ title, items }: StatusSummaryCardProps) => {
  return (
    <Card className="status-summary-card">
      <Box p="4">
        <Heading size="4" mb="3">
          {title}
        </Heading>
        <Flex direction="column" gap="3">
          {items.map((item, index) => (
            <Flex key={index} justify="between" align="center">
              <Flex align="center" gap="2">
                <Box className="status-icon-container">
                  <Box style={{ color: item.iconColor }}>{item.icon}</Box>
                </Box>
                <Text size="2">{item.label}</Text>
              </Flex>
              <Heading size="5">{item.value}</Heading>
            </Flex>
          ))}
        </Flex>
      </Box>
    </Card>
  );
};

export default StatusSummaryCard;
