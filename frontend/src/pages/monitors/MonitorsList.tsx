import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Box,
  Flex,
  Heading,
  Text,
  IconButton,
  Grid,
  Container,
} from "@/components/ui/theme-shim";
import {
  Button,
  Table,
  Badge,
  Card,
  Tabs,
  Dialog,
  TableBody,
  TableCell,
  TableRow,
  TableHeader,
  TabsList,
  TabsTrigger,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui";

import {
  PlusIcon,
  Pencil1Icon,
  TrashIcon,
  CheckCircledIcon,
  CrossCircledIcon,
  QuestionMarkCircledIcon,
  LayoutIcon,
  ViewGridIcon,
  ReloadIcon,
  InfoCircledIcon,
} from "@radix-ui/react-icons";
import {
  getAllMonitors,
  deleteMonitor,
  getAllDailyStats,
  getAllMonitorHistory,
} from "../../api/monitors";
import { MonitorWithDailyStatsAndStatusHistory } from "../../types/monitors";
import MonitorCard from "../../components/MonitorCard";
import { useTranslation } from "react-i18next";
import { usePolling } from "../../hooks/usePolling";

const MonitorsList = () => {
  const navigate = useNavigate();
  const [monitors, setMonitors] = useState<
    MonitorWithDailyStatsAndStatusHistory[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "grid">("grid");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedMonitorId, setSelectedMonitorId] = useState<number | null>(
    null
  );
  const { t } = useTranslation();

  // 获取监控数据
  const fetchData = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const [response, responseDailyStats, responseMonitorHistory] =
        await Promise.all([
          getAllMonitors(signal),
          getAllDailyStats(signal),
          getAllMonitorHistory(signal),
        ]);
      if (signal?.aborted) return;

      if (
        response.success &&
        responseDailyStats.success &&
        responseMonitorHistory.success
      ) {
        const dailyStatsByMonitor = new Map<
          number,
          NonNullable<typeof responseDailyStats.dailyStats>
        >();
        for (const stat of responseDailyStats.dailyStats ?? []) {
          const stats = dailyStatsByMonitor.get(stat.monitor_id) ?? [];
          stats.push(stat);
          dailyStatsByMonitor.set(stat.monitor_id, stats);
        }

        const historyByMonitor = new Map<
          number,
          NonNullable<typeof responseMonitorHistory.history>
        >();
        for (const item of responseMonitorHistory.history ?? []) {
          const history = historyByMonitor.get(item.monitor_id) ?? [];
          history.push(item);
          historyByMonitor.set(item.monitor_id, history);
        }

        const monitorsWithData = response.monitors?.map((monitor) => {
          const dailyStats = dailyStatsByMonitor.get(monitor.id) ?? [];
          const history = historyByMonitor.get(monitor.id) ?? [];
          // 返回附加了相关数据的 monitor
          return {
            ...monitor,
            dailyStats: dailyStats,
            history: history,
          };
        });
        setMonitors(monitorsWithData || []);
      } else {
        setError(response.message || t("monitors.loadingError"));
      }
    } catch (error) {
      if (!signal?.aborted) {
        setError(
          error instanceof Error ? error.message : t("monitors.loadingError")
        );
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [t]);

  usePolling(fetchData, {
    intervalMs: 60000,
  });

  // 处理刷新
  const handleRefresh = () => {
    fetchData();
  };

  // 打开删除确认对话框
  const handleDeleteClick = (id: number) => {
    setSelectedMonitorId(id);
    setDeleteDialogOpen(true);
  };

  // 确认删除监控
  const handleDeleteConfirm = async () => {
    if (selectedMonitorId) {
      try {
        setLoading(true);
        const response = await deleteMonitor(selectedMonitorId);

        if (response.success) {
          // 更新列表，移除已删除的监控
          setMonitors(
            monitors.filter((monitor) => monitor.id !== selectedMonitorId)
          );
        } else {
          setError(response.message || t("monitors.delete.failed"));
        }
      } catch (err) {
        console.error(t("monitors.delete.failed"), err);
        setError(t("monitors.delete.failed"));
      } finally {
        setDeleteDialogOpen(false);
        setSelectedMonitorId(null);
        setLoading(false);
      }
    }
  };

  // 状态图标
  const StatusIcon = ({ status }: { status: string }) => {
    switch (status) {
      case "up":
        return <CheckCircledIcon style={{ color: "var(--green-9)" }} />;
      case "down":
        return <CrossCircledIcon style={{ color: "var(--red-9)" }} />;
      default:
        return <QuestionMarkCircledIcon style={{ color: "var(--gray-9)" }} />;
    }
  };

  // 状态颜色映射
  const statusColors: { [key: string]: "green" | "red" | "gray" } = {
    up: "green",
    down: "red",
    pending: "gray",
  };

  // 加载中显示
  if (loading) {
    return (
      <Box>
        <Flex justify="center" align="center" p="4">
          <Text>{t("common.loading")}</Text>
        </Flex>
      </Box>
    );
  }

  // 错误显示
  if (error) {
    return (
      <Box>
        <Card>
          <Flex>
            <Text>{error}</Text>
          </Flex>
        </Card>
        <Button variant="secondary" onClick={() => window.location.reload()}>
          {t("monitors.retry")}
        </Button>
      </Box>
    );
  }

  return (
    <Container className="sm:px-6 lg:px-[8%]">
      <Flex justify="between" align="start" direction={{ initial: "column", sm: "row" }}>
        <Heading size="6">{t("monitors.pageTitle")}</Heading>
        <Flex className="mt-4 space-x-2">
          <Tabs defaultValue="grid">
            <TabsList>
              <TabsTrigger value="grid" onClick={() => setView("grid")}>
                <ViewGridIcon />
              </TabsTrigger>
              <TabsTrigger value="list" onClick={() => setView("list")}>
                <LayoutIcon />
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            variant="secondary"
            onClick={handleRefresh}
            disabled={loading}
          >
            <ReloadIcon />
            {t("monitors.refresh")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => navigate("/monitors/create")}
          >
            <PlusIcon />
            {t("monitors.create")}
          </Button>
        </Flex>
      </Flex>

      <Container className="my-4 space-x-2">
        {monitors.length === 0 ? (
          <Card>
            <Flex
              direction="column"
              align="center"
              justify="center"
              p="6"
              gap="3"
            >
              <Text>{t("monitors.notFound")}</Text>
              <Button onClick={() => navigate("/monitors/create")}>
                <PlusIcon />
                {t("monitors.addOne")}
              </Button>
            </Flex>
          </Card>
        ) : view === "list" ? (
          // 列表视图
          <Table>
            <TableHeader>
              <TableRow>
                <TableCell>{t("monitors.table.name")}</TableCell>
                <TableCell>{t("monitors.table.url")}</TableCell>
                <TableCell>{t("monitors.table.status")}</TableCell>
                <TableCell>{t("monitors.table.responseTime")}</TableCell>
                <TableCell>{t("monitors.table.actions")}</TableCell>
              </TableRow>
            </TableHeader>

            <TableBody>
              {monitors.map((monitor) => (
                <TableRow key={`${monitor.id}-${Math.random()}`}>
                  <TableCell>
                    <Text weight="medium">{monitor.name}</Text>
                  </TableCell>
                  <TableCell>
                    <Text>{monitor.url}</Text>
                  </TableCell>
                  <TableCell>
                    <Flex align="center" gap="2">
                      <StatusIcon status={monitor.status} />
                      <Badge color={statusColors[monitor.status]}>
                        {monitor.status === "up"
                          ? t("monitors.status.up")
                          : monitor.status === "down"
                          ? t("monitors.status.down")
                          : t("monitor.status.pending")}
                      </Badge>
                    </Flex>
                  </TableCell>
                  <TableCell>
                    <Text>
                      {monitor.response_time
                        ? `${monitor.response_time}ms`
                        : "-"}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <Flex gap="2">
                      <IconButton
                        variant="soft"
                        onClick={() => navigate(`/monitors/${monitor.id}`)}
                        title={t("monitors.viewDetails")}
                      >
                        <InfoCircledIcon />
                      </IconButton>
                      <IconButton
                        variant="soft"
                        onClick={() => navigate(`/monitors/edit/${monitor.id}`)}
                        title={t("monitors.edit")}
                      >
                        <Pencil1Icon />
                      </IconButton>
                      <IconButton
                        variant="soft"
                        color="red"
                        onClick={() => handleDeleteClick(monitor.id)}
                        title={t("monitors.delete")}
                      >
                        <TrashIcon />
                      </IconButton>
                    </Flex>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          // 网格视图 - 使用 MonitorCard 组件
          <Grid columns={{ initial: "1" }} gap="4">
            {monitors.map((monitor) => (
              <Box key={`${monitor.id}-${Math.random()}`} className="relative">
                <MonitorCard monitor={monitor} />
                <Flex gap="2" className="absolute top-4 right-4">
                  <IconButton
                    variant="ghost"
                    size="1"
                    onClick={() => navigate(`/monitors/${monitor.id}`)}
                    title={t("monitors.viewDetails")}
                  >
                    <InfoCircledIcon />
                  </IconButton>
                  <IconButton
                    variant="ghost"
                    size="1"
                    onClick={() => navigate(`/monitors/edit/${monitor.id}`)}
                    title={t("monitors.edit")}
                  >
                    <Pencil1Icon />
                  </IconButton>
                  <IconButton
                    variant="ghost"
                    size="1"
                    color="red"
                    onClick={() => handleDeleteClick(monitor.id)}
                    title={t("monitors.delete")}
                  >
                    <TrashIcon />
                  </IconButton>
                </Flex>
              </Box>
            ))}
          </Grid>
        )}
      </Container>

      {/* 删除确认对话框 */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogTitle>{t("common.deleteConfirmation")}</DialogTitle>
          <DialogDescription>
            {t("common.deleteConfirmMessage")}
          </DialogDescription>
          <Flex gap="3" mt="4" justify="end">
            <DialogClose>
              <Button variant="secondary">{t("common.cancel")}</Button>
            </DialogClose>
            <Button onClick={handleDeleteConfirm}>{t("common.delete")}</Button>
          </Flex>
        </DialogContent>
      </Dialog>
    </Container>
  );
};

export default MonitorsList;
