import { useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Box,
  Flex,
  Text,
  Grid,
  Container,
} from "@/components/ui/layout";
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
  DownloadIcon,
  UploadIcon,
} from "@radix-ui/react-icons";
import { toast } from "sonner";
import {
  getMonitorsPage,
  deleteMonitor,
  updateMonitorsOrder,
  exportMonitors,
  importMonitors,
  type MonitorDailyStats,
  type MonitorHistory,
  type MonitorV2,
} from "../../api/monitors";
import { downloadJson, readJsonArrayFile } from "../../utils/importExport";
import MonitorCard from "../../components/MonitorCard";
import PageLoading from "../../components/PageLoading";
import { useTranslation } from "react-i18next";
import { monitorStatusColors } from "../../utils/statusColors";

type MonitorListItem = MonitorV2 & {
  dailyStats: MonitorDailyStats[];
  history: MonitorHistory[];
};

const monitorListQueryKey = ["monitors", "management-list"] as const;

const MonitorsList = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [view, setView] = useState<"list" | "grid">("grid");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedMonitorId, setSelectedMonitorId] = useState<number | null>(
    null
  );
  // 拖拽排序状态（仅卡片视图启用）
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const { t } = useTranslation();
  const [cursor, setCursor] = useState<string | undefined>();
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);
  const monitorPageQueryKey = [
    ...monitorListQueryKey,
    cursor ?? null,
  ] as const;

  const monitorsQuery = useQuery({
    queryKey: monitorPageQueryKey,
    queryFn: async ({ signal }) => {
      const page = await getMonitorsPage({ cursor, limit: 50 }, signal);
      return {
        ...page,
        data: page.data.map((monitor) => ({
          ...monitor,
          // 管理列表保持有界，只展示当前状态；完整图表在详情页按单资源读取。
          dailyStats: [] as MonitorDailyStats[],
          history: [] as MonitorHistory[],
        })),
      };
    },
    refetchInterval: 60_000,
  });
  const monitors: MonitorListItem[] = monitorsQuery.data?.data ?? [];
  const nextCursor = monitorsQuery.data?.has_more
    ? monitorsQuery.data.next_cursor
    : null;
  const canReorder = cursorHistory.length === 0 && !nextCursor;
  const loading = monitorsQuery.isPending;
  const error = monitorsQuery.error;

  const orderMutation = useMutation({
    mutationFn: async (next: MonitorListItem[]) =>
      updateMonitorsOrder(next.map((monitor) => monitor.id)),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: monitorPageQueryKey });
      const previous = queryClient.getQueryData<typeof monitorsQuery.data>(
        monitorPageQueryKey
      );
      queryClient.setQueryData(monitorPageQueryKey, (current: typeof previous) =>
        current ? { ...current, data: next } : current
      );
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context?.previous) {
        queryClient.setQueryData(monitorPageQueryKey, context.previous);
      }
      toast.error(t("common.orderSaveError"));
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: monitorListQueryKey }),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteMonitor,
    onSuccess: (_value, id) => {
      queryClient.setQueryData(monitorPageQueryKey, (current: typeof monitorsQuery.data) =>
        current
          ? {
              ...current,
              data: current.data.filter(
                (monitor: MonitorListItem) => monitor.id !== id
              ),
            }
          : current
      );
    },
    onError: () => toast.error(t("monitors.delete.failed")),
    onSettled: () => {
      setDeleteDialogOpen(false);
      setSelectedMonitorId(null);
      queryClient.invalidateQueries({ queryKey: monitorListQueryKey });
    },
  });

  const importMutation = useMutation({
    mutationFn: importMonitors,
    onSuccess: (result) => {
      toast.success(
        t("common.importResult", {
          created: result.created,
          skipped: result.skipped,
        })
      );
      queryClient.invalidateQueries({ queryKey: monitorListQueryKey });
    },
    onError: () => toast.error(t("common.importError")),
  });

  // 处理刷新
  const handleRefresh = () => {
    monitorsQuery.refetch();
  };

  // 拖拽落点：本地乐观重排 → 调 order 接口，失败回滚并 toast
  const handleDrop = async (targetId: number) => {
    if (!canReorder) return;
    const sourceId = draggingId;
    setDraggingId(null);
    setDragOverId(null);
    if (sourceId === null || sourceId === targetId) return;

    const fromIndex = monitors.findIndex((monitor) => monitor.id === sourceId);
    const toIndex = monitors.findIndex((monitor) => monitor.id === targetId);
    if (fromIndex < 0 || toIndex < 0) return;

    const next = [...monitors];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    orderMutation.mutate(next);
  };

  const nextPage = () => {
    if (!nextCursor) return;
    setCursorHistory((history) => [...history, cursor]);
    setCursor(nextCursor);
  };

  const previousPage = () => {
    setCursor(cursorHistory.at(-1));
    setCursorHistory((history) => history.slice(0, -1));
  };

  // 导出为 JSON 文件下载
  const handleExport = async () => {
    try {
      const data = await exportMonitors();
      downloadJson(data, "xugou-monitors.json");
    } catch (err) {
      console.error("导出监控失败:", err);
      toast.error(t("common.exportError"));
    }
  };

  // 导入：读取文件 → POST → toast 显示 {created, skipped}
  const handleImportFile = async (file: File) => {
    const items = await readJsonArrayFile(file);
    if (!items) {
      toast.error(t("common.importInvalidFile"));
      return;
    }
    importMutation.mutate(items);
  };

  // 打开删除确认对话框
  const handleDeleteClick = (id: number) => {
    setSelectedMonitorId(id);
    setDeleteDialogOpen(true);
  };

  // 确认删除监控
  const handleDeleteConfirm = async () => {
    if (selectedMonitorId) {
      deleteMutation.mutate(selectedMonitorId);
    }
  };

  // 状态图标
  const StatusIcon = ({ status }: { status: string }) => {
    switch (status) {
      case "up":
        return <CheckCircledIcon style={{ color: "var(--accent-green)" }} />;
      case "down":
        return <CrossCircledIcon style={{ color: "var(--accent-red)" }} />;
      default:
        return (
          <QuestionMarkCircledIcon style={{ color: "var(--text-secondary)" }} />
        );
    }
  };

  // 加载中显示
  if (loading) {
    return <PageLoading />;
  }

  // 错误显示
  if (error) {
    return (
      <Box>
        <Card>
          <Flex>
          <Text>{error instanceof Error ? error.message : t("monitors.loadingError")}</Text>
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
        <h1 className="prompt-title">{t("monitors.pageTitle")}</h1>
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
            disabled={monitorsQuery.isFetching}
          >
            <ReloadIcon />
            {t("monitors.refresh")}
          </Button>
          <Button variant="secondary" onClick={handleExport}>
            <DownloadIcon />
            {t("common.export")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => importInputRef.current?.click()}
          >
            <UploadIcon />
            {t("common.import")}
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) handleImportFile(file);
            }}
          />
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
        {!canReorder && monitors.length > 0 ? (
          <p className="mb-3 text-xs text-muted-foreground">
            {t("common.reorderSinglePageOnly")}
          </p>
        ) : null}
        {monitors.length === 0 ? (
          <Card>
            <Flex direction="column" align="center" justify="center" gap="3" pb="6">
              <div className="empty-state">{t("monitors.notFound")}</div>
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
                <TableRow key={monitor.id}>
                  <TableCell>
                    <Text weight="medium">{monitor.name}</Text>
                  </TableCell>
                  <TableCell>
                    <Text>{monitor.url}</Text>
                  </TableCell>
                  <TableCell>
                    <Flex align="center" gap="2">
                      <StatusIcon status={monitor.status ?? "pending"} />
                      <Badge color={monitorStatusColors[monitor.status ?? "pending"] ?? "gray"}>
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
                      {monitor.response_time_ms
                        ? `${monitor.response_time_ms}ms`
                        : "-"}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <Flex gap="2">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => navigate(`/monitors/${monitor.id}`)}
                        title={t("monitors.viewDetails")}
                      >
                        <InfoCircledIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => navigate(`/monitors/edit/${monitor.id}`)}
                        title={t("monitors.edit")}
                      >
                        <Pencil1Icon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        onClick={() => handleDeleteClick(monitor.id)}
                        title={t("monitors.delete")}
                      >
                        <TrashIcon />
                      </Button>
                    </Flex>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          // 网格视图 - 使用 MonitorCard 组件（原生 HTML5 拖拽排序）
          <Grid columns={{ initial: "1" }} gap="4">
            {monitors.map((monitor) => (
              <Box
                key={monitor.id}
                className={`relative drag-item${
                  draggingId === monitor.id ? " dragging" : ""
                }${
                  dragOverId === monitor.id && draggingId !== monitor.id
                    ? " drag-over"
                    : ""
                }`}
                draggable={canReorder}
                onDragStart={(e: DragEvent<HTMLDivElement>) => {
                  setDraggingId(monitor.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => {
                  setDraggingId(null);
                  setDragOverId(null);
                }}
                onDragOver={(e: DragEvent<HTMLDivElement>) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (dragOverId !== monitor.id) setDragOverId(monitor.id);
                }}
                onDragLeave={() => {
                  if (dragOverId === monitor.id) setDragOverId(null);
                }}
                onDrop={(e: DragEvent<HTMLDivElement>) => {
                  e.preventDefault();
                  handleDrop(monitor.id);
                }}
              >
                <MonitorCard monitor={monitor} compact />
                <Flex gap="2" className="absolute top-4 right-4">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => navigate(`/monitors/${monitor.id}`)}
                    title={t("monitors.viewDetails")}
                  >
                    <InfoCircledIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => navigate(`/monitors/edit/${monitor.id}`)}
                    title={t("monitors.edit")}
                  >
                    <Pencil1Icon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    onClick={() => handleDeleteClick(monitor.id)}
                    title={t("monitors.delete")}
                  >
                    <TrashIcon />
                  </Button>
                </Flex>
              </Box>
            ))}
          </Grid>
        )}
      </Container>

      <div className="mb-4 flex items-center justify-between px-4">
        <span className="text-xs text-muted-foreground">
          {t("common.pageItemCount", { count: monitors.length })}
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={monitorsQuery.isFetching || cursorHistory.length === 0}
            onClick={previousPage}
          >
            {t("common.previousPage")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={monitorsQuery.isFetching || !nextCursor}
            onClick={nextPage}
          >
            {t("common.nextPage")}
          </Button>
        </div>
      </div>

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
            <Button
              onClick={handleDeleteConfirm}
              disabled={deleteMutation.isPending}
            >
              {t("common.delete")}
            </Button>
          </Flex>
        </DialogContent>
      </Dialog>
    </Container>
  );
};

export default MonitorsList;
