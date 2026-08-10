import { useParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, Flex, Text, Grid } from "@/components/ui/layout";
import { Button, Badge } from "@/components/ui";
import {
  ArrowLeftIcon,
  Pencil1Icon,
  TrashIcon,
  ReloadIcon,
} from "@radix-ui/react-icons";
import { toast } from "sonner";
import {
  getMonitor,
  deleteMonitor,
  checkMonitor,
  getMonitorHistory,
  getMonitorDailyStats,
} from "../../api/monitors";
import { useTranslation } from "react-i18next";
import ResponseTimeChart from "../../components/ResponseTimeChart";
import PageLoading from "../../components/PageLoading";
import StatusBar from "../../components/MonitorStatusBar";
import { monitorStatusColors } from "../../utils/statusColors";

// 将范围状态码转换为可读形式（2 -> 2xx, 3 -> 3xx 等）
const formatStatusCode = (code: number | undefined): string => {
  if (code === undefined) return "200";

  // 对于1-5这些值，显示为1xx、2xx、3xx等
  if (code >= 1 && code <= 5) {
    return `${code}xx`;
  }
  // 其他正常显示数字
  return code.toString();
};

const MonitorDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const monitorId = Number(id);
  const hasValidMonitorId = Boolean(id) && !Number.isNaN(monitorId);

  const monitorQuery = useQuery({
    queryKey: ["monitors", "detail", monitorId],
    enabled: hasValidMonitorId,
    queryFn: async ({ signal }) => {
      const [monitor, history, dailyStats] = await Promise.all([
        getMonitor(monitorId, signal),
        getMonitorHistory(monitorId, signal),
        getMonitorDailyStats(monitorId, signal),
      ]);
      return { ...monitor, history, dailyStats };
    },
    refetchInterval: 60_000,
  });
  const monitor = monitorQuery.data;

  const checkMutation = useMutation({
    mutationFn: () => checkMonitor(monitorId),
    onSuccess: () => {
      toast.success(t("monitor.checkCompleted"));
      queryClient.invalidateQueries({ queryKey: ["monitors"] });
    },
    onError: () => toast.error(t("monitor.checkFailed")),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteMonitor(monitorId),
    onSuccess: () => {
      toast.success(t("monitor.deleteSuccess"));
      queryClient.removeQueries({ queryKey: ["monitors", "detail", monitorId] });
      navigate("/monitors");
    },
    onError: () => toast.error(t("monitor.deleteFailed")),
  });

  // 手动检查监控状态
  const handleCheck = async () => {
    if (hasValidMonitorId) checkMutation.mutate();
  };

  // 删除监控
  const handleDelete = async () => {
    if (!id || !window.confirm(t("monitors.delete.confirm"))) return;

    deleteMutation.mutate();
  };

  // 加载中显示
  if (monitorQuery.isPending) {
    return <PageLoading />;
  }

  // 错误显示
  if (monitorQuery.error || !monitor) {
    return (
      <Box className="monitor-detail" p="4">
        <Text style={{ color: "var(--accent-red)" }}>
          {monitorQuery.error instanceof Error
            ? monitorQuery.error.message
            : t("monitor.notExist")}
        </Text>
        <Button variant="secondary" onClick={() => navigate("/monitors")}>
          {t("monitor.returnToList")}
        </Button>
      </Box>
    );
  }

  return (
    <Box className="page-container">
      <Flex justify="between" align="start" direction={{ initial: "column", sm: "row" }} gap="4">
        <Flex align="center" gap="2">
          <Button variant="secondary" onClick={() => navigate("/monitors")}>
            <ArrowLeftIcon />
          </Button>
          <h1 className="prompt-title">{monitor.name}</h1>
          <Badge color={monitorStatusColors[monitor.status ?? "pending"] ?? "gray"}>
            {monitor.status === "up"
              ? t("monitor.status.normal")
              : monitor.status === "down"
              ? t("monitor.status.failure")
              : t("monitor.status.pending")}
          </Badge>
        </Flex>
        <Flex gap="2">
          <Button
            variant="secondary"
            onClick={handleCheck}
            disabled={checkMutation.isPending}
          >
            <ReloadIcon />
            {t("monitor.manualCheck")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => navigate(`/monitors/edit/${id}`)}
          >
            <Pencil1Icon />
            {t("monitor.edit")}
          </Button>
          <Button
            variant="secondary"
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
          >
            <TrashIcon />
            {t("monitor.delete")}
          </Button>
        </Flex>
      </Flex>
      <Flex py="4" gap="4" direction="column" >
        <div className="terminal-card p-4">
          <Flex direction="column" gap="2">
            <h2 className="group-title">{t("monitor.detailInfo")}</h2>
            <Grid columns="2" gap="3">
              <Text>URL:</Text>
              <Text>{monitor.url}</Text>
              <Text>{t("monitor.method")}:</Text>
              <Text>{monitor.method}</Text>
              <Text>{t("monitor.interval")}:</Text>
              <Text>
                {monitor.interval_seconds} {t("common.seconds")}
              </Text>
              <Text>{t("monitor.timeout")}:</Text>
              <Text>
                {monitor.timeout_ms / 1000} {t("common.seconds")}
              </Text>
              <Text>{t("monitor.expectedStatus")}:</Text>
              <Text>{formatStatusCode(monitor.expected_status)}</Text>
              <Text>{t("monitor.createTime")}:</Text>
              <Text>{monitor.created_at}</Text>
              <Text>{t("monitor.headers")}:</Text>
              <Text className="break-words">
                {typeof monitor.headers === "string"
                  ? monitor.headers
                  : JSON.stringify(monitor.headers)}
              </Text>
              <Text>{t("monitor.body")}:</Text>
              <Text className="break-words">
                {monitor.body || "-"}
              </Text>
            </Grid>
          </Flex>
        </div>
        {/* 添加响应时间图表 */}
        <div className="terminal-card p-4">
          <Flex direction="column" gap="2">
            <h2 className="group-title">{t("monitor.oneDayHistory")}</h2>
            <Box>
              <ResponseTimeChart history={monitor.history || []} height={220} />
            </Box>
          </Flex>
        </div>
        <div className="terminal-card p-4">
          <Flex direction="column" gap="2">
            <h2 className="group-title">{t("monitor.MonthsHistory")}</h2>
            <Box>
              <StatusBar dailyStats={monitor.dailyStats || []} />
            </Box>
          </Flex>
        </div>
      </Flex>
    </Box>
  );
};

export default MonitorDetail;
