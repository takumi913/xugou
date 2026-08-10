import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, Flex, Text, Container } from "@/components/ui/layout";
import PageLoading from "../../components/PageLoading";
import TagSelect from "../../components/TagSelect";
import {
  Button,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Input,
} from "@/components/ui";
import { EyeOpenIcon, CopyIcon, CheckIcon } from "@radix-ui/react-icons";
import { toast } from "sonner";
import { getStatusPageConfig, saveStatusPageConfig } from "../../api/status";
import { StatusPageConfig as StatusConfig } from "../../types/status";
import { useTranslation } from "react-i18next";

// 监控项带选择状态
interface MonitorWithSelection {
  id: number;
  name: string;
  selected: boolean;
}

// 客户端带选择状态
interface AgentWithSelection {
  id: number;
  name: string;
  selected: boolean;
}

// 状态页配置带详细信息
interface StatusConfigWithDetails {
  title: string;
  description: string;
  logoUrl: string;
  customCss: string;
  // 主题 id 在「主题」页管理，这里仅透传，避免保存时被重置
  theme: string;
  publicUrl: string;
  monitors: MonitorWithSelection[];
  agents: AgentWithSelection[];
}

const StatusPageConfig = () => {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [dirty, setDirty] = useState(false);
  const { t } = useTranslation();

  // 初始化配置对象
  const [config, setConfig] = useState<StatusConfigWithDetails>({
    title: t("statusPage.title"),
    description: t("statusPage.allOperational"),
    logoUrl: "",
    customCss: "",
    theme: "mono",
    publicUrl: "",
    monitors: [],
    agents: [],
  });

  useEffect(() => {
    setConfig((prev) => ({
      ...prev,
      publicUrl: `${window.location.origin}/status`,
    }));
  }, []);

  const configQuery = useQuery({
    queryKey: ["status", "config"],
    queryFn: ({ signal }) => getStatusPageConfig(signal),
  });

  useEffect(() => {
    const configResponse = configQuery.data;
    if (!configResponse || dirty) return;
    setConfig((prev) => ({
      ...prev,
      title: configResponse.title || t("statusPage.title"),
      description: configResponse.description || t("statusPage.allOperational"),
      logoUrl: configResponse.logoUrl || "",
      customCss: configResponse.customCss || "",
      theme: configResponse.theme || "mono",
      monitors: configResponse.monitors || [],
      agents: configResponse.agents || [],
    }));
  }, [configQuery.data, dirty, t]);

  useEffect(() => {
    if (configQuery.error) toast.error(t("common.error.fetch"));
  }, [configQuery.error, t]);

  const saveMutation = useMutation({
    mutationFn: saveStatusPageConfig,
    onSuccess: async () => {
      setDirty(false);
      toast.success(t("statusPageConfig.configSaved"));
      await queryClient.invalidateQueries({ queryKey: ["status"] });
    },
    onError: () => toast.error(t("statusPageConfig.saveError")),
  });

  // 处理表单字段变化
  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    setConfig((prev) => ({
      ...prev,
      [name]: value,
    }));
    setDirty(true);
  };

  // 复制公共URL
  const handleCopyUrl = () => {
    navigator.clipboard.writeText(config.publicUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // 保存配置
  const handleSave = () => {
    // 构建要保存的配置对象
    const configToSave: StatusConfig = {
      title: config.title,
      description: config.description,
      logoUrl: config.logoUrl,
      customCss: config.customCss,
      theme: config.theme,
      monitors: config.monitors
        .filter((m: MonitorWithSelection) => m.selected)
        .map((m: MonitorWithSelection) => m.id),
      agents: config.agents
        .filter((a: AgentWithSelection) => a.selected)
        .map((a: AgentWithSelection) => a.id),
    };

    saveMutation.mutate(configToSave);
  };

  // 预览状态页
  const handlePreview = () => {
    // 在新标签页中打开状态页
    window.open("/status", "_blank");
  };

  if (configQuery.isPending) {
    return (
      <Box>
        <div className="page-container detail-page">
          <PageLoading />
        </div>
      </Box>
    );
  }

  return (
    <Container>
      <Box>
        <Flex
          justify="between"
          align="start"
          direction={{ initial: "column", sm: "row" }}
        >
          <Flex align="center">
            <h1 className="prompt-title">{t("statusPageConfig.title")}</h1>
          </Flex>
          <Flex align="center" className="mt-2">
            <Button
              variant="secondary"
              className="mr-2"
              onClick={handlePreview}
            >
              <EyeOpenIcon width="8" height="8" />
              <Text size="2">{t("statusPageConfig.preview")}</Text>
            </Button>
            <Button variant="secondary" onClick={handleSave} disabled={saveMutation.isPending || !dirty}>
              {saveMutation.isPending ? (
                <>
                  <span className="inline-flex h-4 w-4 items-center justify-center">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        d="M12,4a8,8,0,0,1,7.89,6.7A1.53,1.53,0,0,0,21.38,12h0a1.5,1.5,0,0,0,1.48-1.75,11,11,0,0,0-21.72,0A1.5,1.5,0,0,0,2.62,12h0a1.53,1.53,0,0,0,1.49-1.3A8,8,0,0,1,12,4Z"
                        fill="currentColor"
                      >
                        <animateTransform
                          attributeName="transform"
                          type="rotate"
                          dur="0.75s"
                          values="0 12 12;360 12 12"
                          repeatCount="indefinite"
                        />
                      </path>
                    </svg>
                  </span>
                  <Text size="2">{t("common.savingChanges")}</Text>
                </>
              ) : (
                <>
                  <CheckIcon width="8" height="8" />
                  <Text size="2">{t("statusPageConfig.save")}</Text>
                </>
              )}
            </Button>
          </Flex>
        </Flex>
      </Box>
      <div className="terminal-card mt-4 p-4">
        <Tabs defaultValue="general">
          <TabsList className="overflow-auto">
            <TabsTrigger value="general">
              {t("statusPageConfig.general")}
            </TabsTrigger>
            <TabsTrigger value="services">
              {t("statusPageConfig.services")}
            </TabsTrigger>
            <TabsTrigger value="agents">
              {t("statusPageConfig.agents")}
            </TabsTrigger>
          </TabsList>

          <Box pt="2" px="2">
            <TabsContent value="general">
              <Flex direction="column" gap="2">
                <Box>
                  <Text as="label" className="text-sm font-medium">
                    {t("statusPageConfig.pageTitle")}
                  </Text>
                  <Input
                    className="h-10"
                    name="title"
                    value={config.title}
                    onChange={handleChange}
                    placeholder={t("statusPageConfig.pageTitlePlaceholder")}
                  />
                </Box>

                <Box>
                  <Text as="label" className="text-sm font-medium">
                    {t("statusPageConfig.pageDescription")}
                  </Text>
                  <Textarea
                    name="description"
                    value={config.description}
                    onChange={handleChange}
                    placeholder={t(
                      "statusPageConfig.pageDescriptionPlaceholder"
                    )}
                  />
                </Box>

                <Box>
                  <Text as="label" className="text-sm font-medium">
                    {t("statusPageConfig.publicUrl")}
                  </Text>
                  <Flex gap="2">
                    <Box className="flex-1 relative">
                      <Input
                        className="h-10"
                        value={config.publicUrl}
                        readOnly
                      />
                    </Box>
                    <Button variant="secondary" onClick={handleCopyUrl}>
                      {copied ? (
                        <>
                          <CheckIcon width="16" height="16" />
                          <Text>{t("common.copied")}</Text>
                        </>
                      ) : (
                        <>
                          <CopyIcon width="16" height="16" />
                          <Text>{t("common.copy")}</Text>
                        </>
                      )}
                    </Button>
                  </Flex>
                  <Text className="text-xs text-[var(--text-secondary)]">
                    {t("statusPageConfig.publicUrlHelp")}
                  </Text>
                </Box>

                <Box className="mt-1">
                  <Text className="text-sm font-medium text-ellipsis">
                    {t("statusPageConfig.selectionNote")}
                  </Text>
                </Box>
              </Flex>
            </TabsContent>

            <TabsContent value="services">
              <Flex direction="column">
                <h2 className="group-title">
                  {t("statusPageConfig.selectServicesPrompt")}{" "}
                  <span className="group-count">
                    [{config.monitors.length}]
                  </span>
                </h2>
                {configQuery.data?.monitors_has_more ? (
                  <Text className="mb-2 text-xs text-[var(--text-secondary)]">
                    {t("statusPageConfig.candidatesTruncated")}
                  </Text>
                ) : null}

                <TagSelect
                  options={config.monitors.map((monitor) => ({
                    id: monitor.id,
                    label: monitor.name,
                  }))}
                  selectedIds={config.monitors
                    .filter((monitor) => monitor.selected)
                    .map((monitor) => monitor.id)}
                  onChange={(ids) => {
                    if (ids.length > 100) {
                      toast.error(t("statusPageConfig.selectionLimit"));
                      return;
                    }
                    setConfig((prev) => ({
                      ...prev,
                      monitors: prev.monitors.map((monitor) => ({
                        ...monitor,
                        selected: ids.includes(monitor.id),
                      })),
                    }));
                    setDirty(true);
                  }}
                  bulkActions
                  emptyText={t("monitors.noMonitors")}
                />
              </Flex>
            </TabsContent>

            <TabsContent value="agents">
              <Flex direction="column">
                <h2 className="group-title">
                  {t("statusPageConfig.selectAgentsPrompt")}{" "}
                  <span className="group-count">[{config.agents.length}]</span>
                </h2>
                {configQuery.data?.agents_has_more ? (
                  <Text className="mb-2 text-xs text-[var(--text-secondary)]">
                    {t("statusPageConfig.candidatesTruncated")}
                  </Text>
                ) : null}

                <TagSelect
                  options={config.agents.map((agent) => ({
                    id: agent.id,
                    label: agent.name,
                  }))}
                  selectedIds={config.agents
                    .filter((agent) => agent.selected)
                    .map((agent) => agent.id)}
                  onChange={(ids) => {
                    if (ids.length > 100) {
                      toast.error(t("statusPageConfig.selectionLimit"));
                      return;
                    }
                    setConfig((prev) => ({
                      ...prev,
                      agents: prev.agents.map((agent) => ({
                        ...agent,
                        selected: ids.includes(agent.id),
                      })),
                    }));
                    setDirty(true);
                  }}
                  bulkActions
                  emptyText={t("agents.noAgents")}
                />
              </Flex>
            </TabsContent>
          </Box>
        </Tabs>
      </div>
    </Container>
  );
};

export default StatusPageConfig;
