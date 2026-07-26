import { useState, useCallback, useRef, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Box,
  Flex,
  Text,
  IconButton,
  Grid,
  Container,
} from "@/components/ui/theme-shim";
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
  getAllAgentsWithLatestMetricsWithSignal,
  deleteAgent,
  updateAgentsOrder,
  exportAgents,
  importAgents,
} from "../../api/agents";
import AgentStatusBar from "../../components/AgentStatusBar";
import PageLoading from "../../components/PageLoading";
import { useTranslation } from "react-i18next";
import { AgentWithLatestMetrics } from "../../types";
import { usePolling } from "../../hooks/usePolling";
import { agentStatusColors } from "../../utils/statusColors";
import { downloadJson, readJsonArrayFile } from "../../utils/importExport";

const AgentsList = () => {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentWithLatestMetrics[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<"table" | "card">("card"); // 默认使用卡片视图
  // 拖拽排序状态（仅卡片视图启用）
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const { t } = useTranslation();

  // 获取客户端数据
  const fetchAgents = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await getAllAgentsWithLatestMetricsWithSignal(signal);
      if (signal?.aborted) return;

      if (response.agents) {
        setAgents(response.agents);
      } else if (!response.success) {
        setError(response.message || t("common.error.fetch"));
      }
    } catch (error) {
      if (!signal?.aborted) {
        setError(
          error instanceof Error ? error.message : t("common.error.fetch")
        );
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [t]);

  usePolling(fetchAgents, {
    intervalMs: 60000,
  });

  // 刷新客户端列表
  const handleRefresh = () => {
    fetchAgents();
  };

  // 拖拽落点：本地乐观重排 → 调 order 接口，失败回滚并 toast
  const handleDrop = async (targetId: number) => {
    const sourceId = draggingId;
    setDraggingId(null);
    setDragOverId(null);
    if (sourceId === null || sourceId === targetId) return;

    const fromIndex = agents.findIndex((agent) => agent.id === sourceId);
    const toIndex = agents.findIndex((agent) => agent.id === targetId);
    if (fromIndex < 0 || toIndex < 0) return;

    const previous = agents;
    const next = [...agents];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setAgents(next);

    const response = await updateAgentsOrder(next.map((agent) => agent.id));
    if (!response.success) {
      setAgents(previous);
      toast.error(t("common.orderSaveError"));
    }
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

  // 导入：读取文件 → POST → toast 显示 {created, skipped}
  const handleImportFile = async (file: File) => {
    const items = await readJsonArrayFile(file);
    if (!items) {
      toast.error(t("common.importInvalidFile"));
      return;
    }
    const response = await importAgents(items);
    if (response.success) {
      toast.success(
        t("common.importResult", {
          created: response.created ?? 0,
          skipped: response.skipped ?? 0,
        })
      );
      fetchAgents();
    } else {
      toast.error(response.message || t("common.importError"));
    }
  };

  // 打开删除确认对话框
  const handleDeleteClick = (agentId: number) => {
    setSelectedAgentId(agentId);
    setDeleteDialogOpen(true);
  };

  // 确认删除客户端
  const handleDeleteConfirm = async () => {
    if (selectedAgentId) {
      setLoading(true);
      try {
        const response = await deleteAgent(selectedAgentId);

        if (response.success) {
          // 删除成功，刷新客户端列表
          fetchAgents();
        } else {
          setError(response.message || t("common.error.delete"));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t("common.error.delete"));
        console.error("删除客户端错误:", err);
      } finally {
        setDeleteDialogOpen(false);
        setSelectedAgentId(null);
        setLoading(false);
      }
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
            draggable
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
              <IconButton
                variant="ghost"
                size="1"
                onClick={() => navigate(`/agents/${agent.id}`)}
                title={t("agent.details")}
              >
                <InfoCircledIcon />
              </IconButton>
              <IconButton
                variant="ghost"
                size="1"
                onClick={() => navigate(`/agents/edit/${agent.id}`)}
                title={t("agent.edit")}
              >
                <Pencil1Icon />
              </IconButton>
              <IconButton
                variant="ghost"
                size="1"
                color="red"
                onClick={() => handleDeleteClick(agent.id)}
                title={t("agent.delete")}
              >
                <TrashIcon />
              </IconButton>
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
                  {agent.ip_addresses
                    ? (() => {
                        try {
                          const ipArray = JSON.parse(
                            String(agent.ip_addresses)
                          );
                          return Array.isArray(ipArray) && ipArray.length > 0
                            ? ipArray.join(", ")
                            : String(agent.ip_addresses);
                        } catch {
                          return String(agent.ip_addresses);
                        }
                      })()
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
                  <IconButton
                    variant="soft"
                    onClick={() => navigate(`/agents/${agent.id}`)}
                  >
                    <InfoCircledIcon />
                  </IconButton>
                  <IconButton
                    variant="soft"
                    onClick={() => navigate(`/agents/edit/${agent.id}`)}
                  >
                    <Pencil1Icon />
                  </IconButton>
                  <IconButton
                    variant="soft"
                    color="red"
                    onClick={() => handleDeleteClick(agent.id)}
                  >
                    <TrashIcon />
                  </IconButton>
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
            <Text>{error}</Text>
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
            disabled={loading}
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
            <Button color="red" onClick={handleDeleteConfirm}>
              {t("common.delete")}
            </Button>
          </Flex>
        </DialogContent>
      </Dialog>
    </Container>
  );
};

export default AgentsList;
