import { useState, useRef, type DragEvent } from "react";
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
  Card,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  Badge,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui";

import {
  PlusIcon,
  Pencil1Icon,
  InfoCircledIcon,
  ReloadIcon,
  LayoutIcon,
  ViewGridIcon,
  TrashIcon,
  DownloadIcon,
  UploadIcon,
} from "@radix-ui/react-icons";
import { toast } from "sonner";
import {
  getAgentsPage,
  deleteAgent,
  updateAgentsOrder,
  exportAgents,
  importAgents,
  type AgentV2,
} from "../../api/agents";
import AgentStatusBar from "../../components/AgentStatusBar";
import PageLoading from "../../components/PageLoading";
import { useTranslation } from "react-i18next";
import { agentStatusColors } from "../../utils/statusColors";
import { downloadJson, readJsonArrayFile } from "../../utils/importExport";

const AgentsList = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<"table" | "card">("card"); // 默认使用卡片视图
  // 拖拽排序状态（仅卡片视图启用）
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const { t } = useTranslation();
  const [cursor, setCursor] = useState<string | undefined>();
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);
  const agentListQueryKey = ["agents", "management-list"] as const;
  const agentPageQueryKey = [...agentListQueryKey, cursor ?? null] as const;

  const agentsQuery = useQuery({
    queryKey: agentPageQueryKey,
    queryFn: ({ signal }) =>
      getAgentsPage(
        { cursor, limit: 50, includeLatestMetrics: true },
        signal
      ),
    refetchInterval: 60_000,
  });
  const agents: AgentV2[] = agentsQuery.data?.data ?? [];
  const nextCursor = agentsQuery.data?.has_more
    ? agentsQuery.data.next_cursor
    : null;
  const canReorder = cursorHistory.length === 0 && !nextCursor;
  const loading = agentsQuery.isPending;
  const error = agentsQuery.error;

  const orderMutation = useMutation({
    mutationFn: async (next: AgentV2[]) =>
      updateAgentsOrder(next.map((agent) => agent.id)),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: agentPageQueryKey });
      const previous = queryClient.getQueryData<typeof agentsQuery.data>(
        agentPageQueryKey
      );
      queryClient.setQueryData(agentPageQueryKey, (current: typeof previous) =>
        current ? { ...current, data: next } : current
      );
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context?.previous) {
        queryClient.setQueryData(agentPageQueryKey, context.previous);
      }
      toast.error(t("common.orderSaveError"));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["agents"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteAgent,
    onSuccess: (_value, id) => {
      queryClient.setQueryData(agentPageQueryKey, (current: typeof agentsQuery.data) =>
        current
          ? {
              ...current,
              data: current.data.filter((agent: AgentV2) => agent.id !== id),
            }
          : current
      );
    },
    onError: () => toast.error(t("common.error.delete")),
    onSettled: () => {
      setDeleteDialogOpen(false);
      setSelectedAgentId(null);
      queryClient.invalidateQueries({ queryKey: agentListQueryKey });
    },
  });

  const importMutation = useMutation({
    mutationFn: importAgents,
    onSuccess: (result) => {
      toast.success(
        t("common.importResult", {
          created: result.created,
          skipped: result.skipped,
        })
      );
      if (result.issuedCredentials.length > 0) {
        downloadJson(result.issuedCredentials, "xugou-agent-credentials.json");
      }
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: () => toast.error(t("common.importError")),
  });

  // 刷新客户端列表
  const handleRefresh = () => {
    agentsQuery.refetch();
  };

  // 拖拽落点：本地乐观重排 → 调 order 接口，失败回滚并 toast
  const handleDrop = async (targetId: number) => {
    if (!canReorder) return;
    const sourceId = draggingId;
    setDraggingId(null);
    setDragOverId(null);
    if (sourceId === null || sourceId === targetId) return;

    const fromIndex = agents.findIndex((agent) => agent.id === sourceId);
    const toIndex = agents.findIndex((agent) => agent.id === targetId);
    if (fromIndex < 0 || toIndex < 0) return;

    const next = [...agents];
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
      const data = await exportAgents();
      downloadJson(data, "xugou-agents.json");
    } catch (err) {
      console.error("导出客户端失败:", err);
      toast.error(t("common.exportError"));
    }
  };

  // 导入：读取文件；缺少 Token 时将一次性签发的凭据单独下载。
  const handleImportFile = async (file: File) => {
    const items = await readJsonArrayFile(file);
    if (!items) {
      toast.error(t("common.importInvalidFile"));
      return;
    }
    importMutation.mutate(items);
  };

  // 打开删除确认对话框
  const handleDeleteClick = (agentId: number) => {
    setSelectedAgentId(agentId);
    setDeleteDialogOpen(true);
  };

  // 确认删除客户端
  const handleDeleteConfirm = async () => {
    if (selectedAgentId) {
      deleteMutation.mutate(selectedAgentId);
    }
  };

  // 展示卡片视图（原生 HTML5 拖拽排序）
  const renderCardView = () => {
    return (
      <Grid columns={{ initial: "1" }} gap="4">
        {agents.map((agent) => (
          <Box
            key={agent.id}
            className={`relative drag-item${
              draggingId === agent.id ? " dragging" : ""
            }${
              dragOverId === agent.id && draggingId !== agent.id
                ? " drag-over"
                : ""
            }`}
            draggable={canReorder}
            onDragStart={(e: DragEvent<HTMLDivElement>) => {
              setDraggingId(agent.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => {
              setDraggingId(null);
              setDragOverId(null);
            }}
            onDragOver={(e: DragEvent<HTMLDivElement>) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dragOverId !== agent.id) setDragOverId(agent.id);
            }}
            onDragLeave={() => {
              if (dragOverId === agent.id) setDragOverId(null);
            }}
            onDrop={(e: DragEvent<HTMLDivElement>) => {
              e.preventDefault();
              handleDrop(agent.id);
            }}
          >
            <AgentStatusBar latestMetric={agent.metrics} agent={agent} />
            <Flex gap="2" className="absolute top-4 right-4">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => navigate(`/agents/${agent.id}`)}
                title={t("agent.details")}
              >
                <InfoCircledIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => navigate(`/agents/edit/${agent.id}`)}
                title={t("agent.edit")}
              >
                <Pencil1Icon />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive hover:text-destructive"
                onClick={() => handleDeleteClick(agent.id)}
                title={t("agent.delete")}
              >
                <TrashIcon />
              </Button>
            </Flex>
          </Box>
        ))}
      </Grid>
    );
  };

  // 展示表格视图
  const renderTableView = () => {
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableCell>{t("agents.table.name")}</TableCell>
            <TableCell>{t("agents.table.host")}</TableCell>
            <TableCell>{t("agents.table.ip")}</TableCell>
            <TableCell>{t("agents.table.status")}</TableCell>
            <TableCell>{t("agents.table.os")}</TableCell>
            <TableCell>{t("agents.table.version")}</TableCell>
            <TableCell>{t("agents.table.actions")}</TableCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {agents.map((agent) => (
            <TableRow key={agent.id}>
              <TableCell>
                <Text weight="medium">{agent.name}</Text>
              </TableCell>
              <TableCell>
                <Text>{agent.hostname || t("common.notFound")}</Text>
              </TableCell>
              <TableCell>
                <Text>
                  {agent.ip_addresses.length > 0
                    ? agent.ip_addresses.join(", ")
                    : t("common.notFound")}
                </Text>
              </TableCell>
              <TableCell>
                <Badge color={agentStatusColors[agent.status || "unknown"] ?? "gray"}>
                  {agent.status === "active"
                    ? t("agent.status.online")
                    : agent.status === "connecting"
                    ? t("agent.status.connecting")
                    : t("agent.status.offline")}
                </Badge>
              </TableCell>
              <TableCell>
                <Text>{agent.os || t("common.notFound")}</Text>
              </TableCell>
              <TableCell>
                <Text>{agent.version || t("common.notFound")}</Text>
              </TableCell>
              <TableCell>
                <Flex gap="2">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => navigate(`/agents/${agent.id}`)}
                  >
                    <InfoCircledIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => navigate(`/agents/edit/${agent.id}`)}
                  >
                    <Pencil1Icon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    onClick={() => handleDeleteClick(agent.id)}
                  >
                    <TrashIcon />
                  </Button>
                </Flex>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  };

  // 加载中显示
  if (loading) {
    return <PageLoading />;
  }

  // 错误显示
  if (error) {
    return (
      <Box className="page-container detail-page">
        <Card>
          <Flex>
            <Text>{error instanceof Error ? error.message : t("common.error.fetch")}</Text>
          </Flex>
        </Card>
        <Button variant="secondary" onClick={() => window.location.reload()}>
          {t("common.retry")}
        </Button>
      </Box>
    );
  }

  return (
    <Container size="4">
      <Flex justify="between" align="start" direction={{ initial: "column", sm: "row" }}>
        <h1 className="prompt-title">{t("agents.pageTitle")}</h1>
        <Flex className="mt-4 space-x-2">
          <Tabs defaultValue="card">
            <TabsList>
              <TabsTrigger
                value="card"
                onClick={() => setViewMode("card")}
                title={t("agents.cardView")}
              >
                <ViewGridIcon />
              </TabsTrigger>
              <TabsTrigger
                value="table"
                onClick={() => setViewMode("table")}
                title={t("agents.tableView")}
              >
                <LayoutIcon />
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            variant="secondary"
            onClick={handleRefresh}
            disabled={agentsQuery.isFetching}
          >
            <ReloadIcon />
            {t("common.refresh")}
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
            onClick={() => navigate("/agents/create")}
          >
            <PlusIcon />
            {t("agents.create")}
          </Button>
        </Flex>
      </Flex>

      <Box className="my-4 space-x-2">
        {!canReorder && agents.length > 0 ? (
          <p className="mb-3 text-xs text-muted-foreground">
            {t("common.reorderSinglePageOnly")}
          </p>
        ) : null}
        {agents.length === 0 ? (
          <Card>
            <Flex direction="column" align="center" justify="center" gap="3" pb="6">
              <div className="empty-state">{t("agents.noAgents")}</div>
              <Button onClick={() => navigate("/agents/create")}>
                <PlusIcon />
                {t("agents.create")}
              </Button>
            </Flex>
          </Card>
        ) : viewMode === "table" ? (
          // 表格视图
          renderTableView()
        ) : (
          // 卡片视图
          renderCardView()
        )}
      </Box>

      <div className="mb-4 flex items-center justify-between px-4">
        <span className="text-xs text-muted-foreground">
          {t("common.pageItemCount", { count: agents.length })}
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={agentsQuery.isFetching || cursorHistory.length === 0}
            onClick={previousPage}
          >
            {t("common.previousPage")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={agentsQuery.isFetching || !nextCursor}
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
            <DialogClose asChild>
              <Button variant="secondary" color="gray">
                {t("common.cancel")}
              </Button>
            </DialogClose>
            <Button
              color="red"
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

export default AgentsList;
