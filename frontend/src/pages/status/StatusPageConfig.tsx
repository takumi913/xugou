import { useState, useEffect, useCallback } from "react";
import { Box, Flex, Heading, Text, Container } from "@/components/ui/theme-shim";
import {
  Card,
  Button,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Checkbox,
  Input,
} from "@/components/ui";
import { EyeOpenIcon, CopyIcon, CheckIcon } from "@radix-ui/react-icons";
import { toast } from "sonner";
import { getStatusPageConfig, saveStatusPageConfig } from "../../api/status";
import { StatusPageConfig as StatusConfig } from "../../types/status";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../providers/AuthProvider";

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
  publicUrl: string;
  monitors: MonitorWithSelection[];
  agents: AgentWithSelection[];
}

const StatusPageConfig = () => {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation();

  // 初始化配置对象
  const [config, setConfig] = useState<StatusConfigWithDetails>({
    title: t("statusPage.title"),
    description: t("statusPage.allOperational"),
    logoUrl: "",
    customCss: "",
    publicUrl: "",
    monitors: [],
    agents: [],
  });

  useEffect(() => {
    if (user) {
      setConfig((prev) => ({
        ...prev,
        publicUrl: `${window.location.origin}/status/public/${user.id}`,
      }));
    }
  }, [user]);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    // 获取状态页配置
    setLoading(true);
    try {
      const configResponse = await getStatusPageConfig(signal);

      if (signal?.aborted) {
        return;
      }

      // 如果获取到有效的配置数据，直接使用
      if (configResponse) {
        setConfig((prev) => ({
          ...prev,
          title: configResponse?.title || t("statusPage.title"),
          description:
            configResponse?.description || t("statusPage.allOperational"),
          logoUrl: configResponse?.logoUrl || "",
          customCss: configResponse?.customCss || "",
          monitors: configResponse.monitors || [],
          agents: configResponse.agents || [],
        }));
      }
    } catch {
      if (!signal?.aborted) {
        toast.error(t("common.error.fetch"));
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [t]);

  // 从API获取数据
  useEffect(() => {
    const abortController = new AbortController();
    fetchData(abortController.signal);

    return () => abortController.abort();
  }, [fetchData]);

  // 处理表单字段变化
  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    setConfig((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  // 处理监控选择变化
  const handleMonitorChange = (id: number, checked: boolean) => {
    setConfig((prev) => ({
      ...prev,
      monitors: prev.monitors.map((monitor) =>
        monitor.id === id ? { ...monitor, selected: checked } : monitor
      ),
    }));
  };

  // 处理客户端监控选择变化
  const handleAgentChange = (id: number, checked: boolean) => {
    // 确保id是有效的数字
    if (isNaN(id) || id <= 0) {
      console.error(t("statusPageConfig.invalidAgentId"), id);
      return;
    }

    setConfig((prev) => ({
      ...prev,
      agents: prev.agents.map((agent) =>
        agent.id === id ? { ...agent, selected: checked } : agent
      ),
    }));
  };

  // 复制公共URL
  const handleCopyUrl = () => {
    navigator.clipboard.writeText(config.publicUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // 保存配置
  const handleSave = async () => {
    setSaving(true);
    // 构建要保存的配置对象
    const configToSave: StatusConfig = {
      title: config.title,
      description: config.description,
      logoUrl: config.logoUrl,
      customCss: config.customCss,
      monitors: config.monitors
        .filter((m: MonitorWithSelection) => m.selected)
        .map((m: MonitorWithSelection) => m.id),
      agents: config.agents
        .filter((a: AgentWithSelection) => a.selected)
        .map((a: AgentWithSelection) => a.id),
    };

    const response = await saveStatusPageConfig(configToSave);

    if (response) {
      toast.success(t("statusPageConfig.configSaved"));
    } else {
      toast.error(t("statusPageConfig.saveError"));
    }
    setSaving(false);
  };

  // 预览状态页
  const handlePreview = () => {
    // 在新标签页中打开状态页
    if (user) {
      window.open(`/status/public/${user.id}`, "_blank");
    }
  };

  if (loading) {
    return (
      <Box>
        <div className="page-container detail-page">
          <Flex justify="center" align="center" style={{ minHeight: "50vh" }}>
            <Text size="3">{t("common.loading")}</Text>
          </Flex>
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
            <Heading size="5" weight="medium">
              {t("statusPageConfig.title")}
            </Heading>
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
            <Button variant="secondary" onClick={handleSave} disabled={saving}>
              {saving ? (
                <>
                  <span
                    style={{
                      width: "16px",
                      height: "16px",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
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
      <Card className="mt-4">
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
                  <Text className="text-xs text-gray-500">
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
                <Text>{t("statusPageConfig.selectServicesPrompt")}</Text>

                {config.monitors.length === 0 ? (
                  <Text>{t("monitors.noMonitors")}</Text>
                ) : (
                  <Box>
                    {config.monitors.map((monitor) => {
                      return (
                        <Flex
                          key={monitor.id}
                          className="items-center justify-between p-2 hover:bg-gray-50 rounded-md"
                        >
                          <Text>{monitor.name}</Text>
                          <Checkbox
                            id={`monitor-${monitor.id}`}
                            className="ml-auto"
                            checked={monitor.selected}
                            onCheckedChange={(checked) => {
                              const newCheckedState = !!checked;
                              handleMonitorChange(monitor.id, newCheckedState);
                            }}
                          />
                        </Flex>
                      );
                    })}
                  </Box>
                )}
              </Flex>
            </TabsContent>

            <TabsContent value="agents">
              <Flex direction="column">
                <Text>{t("statusPageConfig.selectAgentsPrompt")}</Text>

                {config.agents.length === 0 ? (
                  <Text color="gray">{t("agents.noAgents")}</Text>
                ) : (
                  <Box>
                    {config.agents.map((agent) => {
                      return (
                        <Flex
                          key={agent.id}
                          className="items-center justify-between p-2 hover:bg-gray-50 rounded-md"
                        >
                          <Text size="3">{agent.name}</Text>
                          <Checkbox
                            id={`agent-${agent.id}`}
                            checked={agent.selected}
                            className="ml-auto"
                            onCheckedChange={(checked) => {
                              const newCheckedState = !!checked;
                              handleAgentChange(agent.id, newCheckedState);
                            }}
                          />
                        </Flex>
                      );
                    })}
                  </Box>
                )}
              </Flex>
            </TabsContent>
          </Box>
        </Tabs>
      </Card>
    </Container>
  );
};

export default StatusPageConfig;
