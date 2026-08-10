import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Box,
  Flex,
  Text,
  Container,
} from "@/components/ui/layout";

import {
  Button,
  Card,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui";

import { BellIcon } from "@radix-ui/react-icons";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  getNotificationConfig,
  saveNotificationSettings,
  createNotificationChannel,
  updateNotificationChannel,
  deleteNotificationChannel,
  testNotificationChannel,
  createNotificationTemplate,
  updateNotificationTemplate,
  deleteNotificationTemplate,
  type NotificationSettings,
  getNotificationResourceSettings,
} from "../../api/notifications";
import type {
  NotificationChannel,
  NotificationTemplate,
} from "../../types/notification";
import ChannelDialog from "@/features/notifications/ChannelDialog";
import ChannelsPanel from "@/features/notifications/ChannelsPanel";
import DeleteConfirmationDialog from "@/features/notifications/DeleteConfirmationDialog";
import {
  GlobalSettingsPanel,
  SpecificAgentsPanel,
  SpecificMonitorsPanel,
} from "@/features/notifications/SettingsPanels";
import TemplateDialog from "@/features/notifications/TemplateDialog";
import TemplatesPanel from "@/features/notifications/TemplatesPanel";
import {
  channelFormToCommand,
  emptyChannelForm,
  emptyChannelFormErrors,
  emptyNotificationTemplateForm,
  notificationChannelFormSchema,
  notificationChannelToForm,
  notificationTemplateFormSchema,
  type ChannelFormErrorKey,
  type NotificationTemplateForm,
} from "@/features/notifications/form-contract";

const NotificationsConfig = () => {
  // 状态管理
  const [settings, setSettings] = useState<NotificationSettings | null>(
    null
  );
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [monitorCursor, setMonitorCursor] = useState<string | undefined>();
  const [monitorCursorHistory, setMonitorCursorHistory] = useState<
    (string | undefined)[]
  >([]);
  const [agentCursor, setAgentCursor] = useState<string | undefined>();
  const [agentCursorHistory, setAgentCursorHistory] = useState<
    (string | undefined)[]
  >([]);

  // 渠道管理状态
  const [isAddChannelOpen, setIsAddChannelOpen] = useState(false);
  const [isEditChannelOpen, setIsEditChannelOpen] = useState(false);
  const [isDeleteChannelOpen, setIsDeleteChannelOpen] = useState(false);
  const [selectedChannelId, setSelectedChannelId] = useState<number | null>(
    null
  );
  const [channelForm, setChannelForm] = useState(emptyChannelForm);
  const [initialChannelForm, setInitialChannelForm] = useState(emptyChannelForm);
  const [channelFormErrors, setChannelFormErrors] = useState({
    ...emptyChannelFormErrors,
  });
  // 模板管理状态
  const [isTemplateDialogOpen, setIsTemplateDialogOpen] = useState(false);
  const [isDeleteTemplateOpen, setIsDeleteTemplateOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] =
    useState<NotificationTemplate | null>(null);
  const [templateForm, setTemplateForm] = useState<NotificationTemplateForm>(
    emptyNotificationTemplateForm
  );
  const [initialTemplateForm, setInitialTemplateForm] =
    useState<NotificationTemplateForm>(emptyNotificationTemplateForm);

  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const configQuery = useQuery({
    queryKey: ["notifications", "config"],
    queryFn: getNotificationConfig,
  });
  const monitorsQuery = useQuery({
    queryKey: [
      "notifications",
      "resource-settings",
      "monitor",
      monitorCursor ?? null,
    ],
    queryFn: ({ signal }) =>
      getNotificationResourceSettings(
        "monitor",
        { cursor: monitorCursor, limit: 25 },
        signal
      ),
  });
  const agentsQuery = useQuery({
    queryKey: [
      "notifications",
      "resource-settings",
      "agent",
      agentCursor ?? null,
    ],
    queryFn: ({ signal }) =>
      getNotificationResourceSettings(
        "agent",
        { cursor: agentCursor, limit: 25 },
        signal
      ),
  });
  const channels: NotificationChannel[] = configQuery.data?.channels ?? [];
  const templates: NotificationTemplate[] = configQuery.data?.templates ?? [];
  const monitorResources = monitorsQuery.data?.data ?? [];
  const agentResources = agentsQuery.data?.data ?? [];
  const nextMonitorCursor = monitorsQuery.data?.has_more
    ? monitorsQuery.data.next_cursor
    : null;
  const nextAgentCursor = agentsQuery.data?.has_more
    ? agentsQuery.data.next_cursor
    : null;
  const loading = configQuery.isPending;
  const monitorsLoading = monitorsQuery.isPending;
  const agentsLoading = agentsQuery.isPending;
  const configMutation = useMutation({
    mutationFn: (operation: () => Promise<unknown>) => operation(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["notifications", "config"] }),
        queryClient.invalidateQueries({
          queryKey: ["notifications", "resource-settings"],
        }),
      ]);
    },
  });
  const testChannelMutation = useMutation({
    mutationFn: testNotificationChannel,
  });
  const saving = configMutation.isPending;
  const testingChannelId = testChannelMutation.isPending
    ? (testChannelMutation.variables ?? null)
    : null;
  const channelDialogOpen = isAddChannelOpen || isEditChannelOpen;
  const channelFormDirty =
    channelDialogOpen &&
    JSON.stringify(channelForm) !== JSON.stringify(initialChannelForm);
  const templateFormDirty =
    isTemplateDialogOpen &&
    JSON.stringify(templateForm) !== JSON.stringify(initialTemplateForm);

  useEffect(() => {
    if (configQuery.data && !settingsDirty) {
      setSettings(configQuery.data.settings);
    }
  }, [configQuery.data, settingsDirty]);

  useEffect(() => {
    if (configQuery.isError) toast.error(t("notifications.fetch.error"));
  }, [configQuery.isError, t]);

  useEffect(() => {
    if (!settingsDirty && !channelFormDirty && !templateFormDirty) return;
    const protectDraft = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", protectDraft);
    return () => window.removeEventListener("beforeunload", protectDraft);
  }, [channelFormDirty, settingsDirty, templateFormDirty]);

  const handleMonitorSettingChange = (
    value: NotificationSettings["monitors"]
  ) => {
    if (!settings) return;
    setSettingsDirty(true);
    setSettings({
      ...settings,
      monitors: value,
    });
  };

  const handleAgentSettingChange = (
    value: NotificationSettings["agents"]
  ) => {
    if (!settings) return;
    setSettingsDirty(true);
    setSettings({
      ...settings,
      agents: value,
    });
  };

  const handleSpecificMonitorSettingChange = (
    monitorId: string,
    value: NotificationSettings["monitors"]
  ) => {
    if (!settings) return;
    setSettingsDirty(true);
    setSettings({
      ...settings,
      specificMonitors: {
        ...settings.specificMonitors,
        [monitorId]: value,
      },
    });
  };

  const handleSpecificAgentSettingChange = (
    agentId: string,
    value: NotificationSettings["agents"]
  ) => {
    if (!settings) return;
    setSettingsDirty(true);
    setSettings({
      ...settings,
      specificAgents: {
        ...settings.specificAgents,
        [agentId]: value,
      },
    });
  };

  // 保存所有设置
  const handleSave = async () => {
    if (!settings) return;

    try {
      await configMutation.mutateAsync(() => saveNotificationSettings(settings));
      setSettingsDirty(false);
      toast.success(t("notifications.save.success"));
    } catch {
      toast.error(t("notifications.save.error"));
    }
  };

  // 打开新增渠道对话框
  const handleAddChannelClick = () => {
    const form = emptyChannelForm();
    setChannelForm(form);
    setInitialChannelForm(form);
    setChannelFormErrors({ ...emptyChannelFormErrors });
    setIsAddChannelOpen(true);
  };

  // 打开编辑渠道对话框
  const handleEditChannelClick = (channel: NotificationChannel) => {
    setSelectedChannelId(channel.id);

    const form = notificationChannelToForm(channel);
    setChannelForm(form);
    setInitialChannelForm(form);
    setChannelFormErrors({ ...emptyChannelFormErrors });
    setIsEditChannelOpen(true);
  };

  // 打开删除渠道对话框
  const handleDeleteChannelClick = (channelId: number) => {
    setSelectedChannelId(channelId);
    setIsDeleteChannelOpen(true);
  };

  // 验证渠道表单
  const validateChannelForm = (): boolean => {
    const parsed = notificationChannelFormSchema.safeParse(channelForm);
    const errors = { ...emptyChannelFormErrors };
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path.at(-1) as ChannelFormErrorKey | undefined;
        if (key && key in errors) {
          errors[key] = t(`notifications.channels.errors.${issue.message}`);
        }
      }
    }
    setChannelFormErrors(errors);
    return parsed.success;
  };

  // 保存渠道
  const handleSaveChannel = async () => {
    if (!validateChannelForm()) return;

    try {
      const channelData = channelFormToCommand(channelForm);

      if (isEditChannelOpen && selectedChannelId !== null) {
        await configMutation.mutateAsync(() =>
          updateNotificationChannel(selectedChannelId, channelData)
        );
        toast.success(t("notifications.channels.updateSuccess"));
        setIsEditChannelOpen(false);
      } else {
        await configMutation.mutateAsync(() => createNotificationChannel(channelData));
        toast.success(t("notifications.channels.createSuccess"));
        setIsAddChannelOpen(false);
      }
    } catch {
      toast.error(t("notifications.channels.saveError"));
    }
  };

  // 发送测试通知
  const handleTestChannelClick = async (channelId: number) => {
    try {
      await testChannelMutation.mutateAsync(channelId);
      toast.success(t("notifications.channels.testSuccess"));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("notifications.channels.testError")
      );
    }
  };

  // 确认删除渠道
  const handleConfirmDeleteChannel = async () => {
    if (selectedChannelId === null) return;
    try {
      await configMutation.mutateAsync(() =>
        deleteNotificationChannel(selectedChannelId)
      );
      toast.success(t("notifications.channels.deleteSuccess"));
      setIsDeleteChannelOpen(false);
    } catch {
      toast.error(t("notifications.channels.deleteError"));
    }
  };

  // 模板操作
  const handleAddTemplateClick = () => {
    setSelectedTemplate(null);
    const form = emptyNotificationTemplateForm();
    setTemplateForm(form);
    setInitialTemplateForm(form);
    setIsTemplateDialogOpen(true);
  };

  const handleEditTemplateClick = (template: NotificationTemplate) => {
    setSelectedTemplate(template);
    const form: NotificationTemplateForm = {
      name: template.name,
      type: template.type,
      subject: template.subject,
      content: template.content,
    };
    setTemplateForm(form);
    setInitialTemplateForm(form);
    setIsTemplateDialogOpen(true);
  };

  const handleDeleteTemplateClick = (template: NotificationTemplate) => {
    setSelectedTemplate(template);
    setIsDeleteTemplateOpen(true);
  };

  // 保存模板
  const handleSaveTemplate = async () => {
    if (!notificationTemplateFormSchema.safeParse(templateForm).success) {
      toast.error(t("notifications.templates.saveError"));
      return;
    }
    try {
      if (selectedTemplate) {
        // 更新模板
        await configMutation.mutateAsync(() =>
          updateNotificationTemplate(selectedTemplate.id, templateForm)
        );
        toast.success(t("notifications.templates.updateSuccess"));
      } else {
        // 创建新模板
        await configMutation.mutateAsync(() =>
          createNotificationTemplate({ ...templateForm, isDefault: false })
        );
        toast.success(t("notifications.templates.createSuccess"));
      }
      setIsTemplateDialogOpen(false);
    } catch {
      toast.error(t("notifications.templates.saveError"));
    }
  };

  // 确认删除模板
  const handleConfirmDeleteTemplate = async () => {
    if (!selectedTemplate) return;
    try {
      await configMutation.mutateAsync(() =>
        deleteNotificationTemplate(selectedTemplate.id)
      );
      toast.success(t("notifications.templates.deleteSuccess"));
      setIsDeleteTemplateOpen(false);
    } catch {
      toast.error(t("notifications.templates.deleteError"));
    }
  };

  // 标签多选的渠道选项（TagSelect 药丸），带类型说明
  const channelOptions = channels.map((channel) => ({
    id: channel.id,
    label: channel.name,
    hint: t(`notifications.channels.type.${channel.type}`),
  }));

  return (
    <Box>
      <Container>
        <Box mb="2">
          <Flex className="flex justify-between items-center detail-header">
            <Flex align="center" gap="2">
              <BellIcon width="20" height="20" />
              <h1 className="prompt-title">{t("notifications.title")}</h1>
            </Flex>
            <Button
              className="ml-auto"
              variant="secondary"
              onClick={handleSave}
              disabled={saving || !settingsDirty}
            >
              {saving ? t("common.savingChanges") : t("common.save")}
            </Button>
          </Flex>
          <Text color="gray" size="2">
            {t("notifications.description")}
          </Text>
          {(configQuery.data?.channelsHasMore ||
            configQuery.data?.templatesHasMore) && (
            <Text as="div" color="amber" size="2" mt="2">
              {t("notifications.dictionaryLimitWarning")}
            </Text>
          )}
        </Box>

        {loading || !settings ? (
          <Text>{t("common.loading")}...</Text>
        ) : (
          <Card className="terminal-card mb-4">
            <Tabs defaultValue="global">
              <TabsList className="overflow-auto">
                <TabsTrigger value="global">
                  {t("notifications.tabs.global")}
                </TabsTrigger>
                <TabsTrigger value="channels">
                  {t("notifications.tabs.channels")}
                </TabsTrigger>
                <TabsTrigger value="templates">
                  {t("notifications.tabs.templates")}
                </TabsTrigger>
                <TabsTrigger value="specificMonitors">
                  {t("notifications.tabs.specificMonitors")}
                </TabsTrigger>
                <TabsTrigger value="specificAgents">
                  {t("notifications.tabs.specificAgents")}
                </TabsTrigger>
              </TabsList>
              <Box pt="2" px="2">
                <TabsContent value="global">
                  <GlobalSettingsPanel
                    settings={settings}
                    channelOptions={channelOptions}
                    onMonitorChange={handleMonitorSettingChange}
                    onAgentChange={handleAgentSettingChange}
                  />
                </TabsContent>
                <TabsContent value="channels">
                  <ChannelsPanel
                    channels={channels}
                    testingChannelId={testingChannelId}
                    onAdd={handleAddChannelClick}
                    onEdit={handleEditChannelClick}
                    onDelete={handleDeleteChannelClick}
                    onTest={handleTestChannelClick}
                  />
                </TabsContent>
                <TabsContent value="templates">
                  <TemplatesPanel
                    templates={templates}
                    onAdd={handleAddTemplateClick}
                    onEdit={handleEditTemplateClick}
                    onDelete={handleDeleteTemplateClick}
                  />
                </TabsContent>
                <TabsContent value="specificMonitors">
                  <SpecificMonitorsPanel
                    resources={monitorResources}
                    loading={monitorsLoading}
                    settings={settings}
                    channelOptions={channelOptions}
                    onChange={handleSpecificMonitorSettingChange}
                  />
                  <div className="mt-3 flex items-center justify-between">
                    <Text size="1" color="gray">
                      {t("common.pageItemCount", {
                        count: monitorResources.length,
                      })}
                    </Text>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          monitorsQuery.isFetching ||
                          monitorCursorHistory.length === 0
                        }
                        onClick={() => {
                          setMonitorCursor(monitorCursorHistory.at(-1));
                          setMonitorCursorHistory((history) =>
                            history.slice(0, -1)
                          );
                        }}
                      >
                        {t("common.previousPage")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={monitorsQuery.isFetching || !nextMonitorCursor}
                        onClick={() => {
                          if (!nextMonitorCursor) return;
                          setMonitorCursorHistory((history) => [
                            ...history,
                            monitorCursor,
                          ]);
                          setMonitorCursor(nextMonitorCursor);
                        }}
                      >
                        {t("common.nextPage")}
                      </Button>
                    </div>
                  </div>
                </TabsContent>
                <TabsContent value="specificAgents">
                  <SpecificAgentsPanel
                    resources={agentResources}
                    loading={agentsLoading}
                    settings={settings}
                    channelOptions={channelOptions}
                    onChange={handleSpecificAgentSettingChange}
                  />
                  <div className="mt-3 flex items-center justify-between">
                    <Text size="1" color="gray">
                      {t("common.pageItemCount", {
                        count: agentResources.length,
                      })}
                    </Text>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          agentsQuery.isFetching ||
                          agentCursorHistory.length === 0
                        }
                        onClick={() => {
                          setAgentCursor(agentCursorHistory.at(-1));
                          setAgentCursorHistory((history) =>
                            history.slice(0, -1)
                          );
                        }}
                      >
                        {t("common.previousPage")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={agentsQuery.isFetching || !nextAgentCursor}
                        onClick={() => {
                          if (!nextAgentCursor) return;
                          setAgentCursorHistory((history) => [
                            ...history,
                            agentCursor,
                          ]);
                          setAgentCursor(nextAgentCursor);
                        }}
                      >
                        {t("common.nextPage")}
                      </Button>
                    </div>
                  </div>
                </TabsContent>
              </Box>
            </Tabs>
          </Card>
        )}
      </Container>

      <ChannelDialog
        open={channelDialogOpen}
        editing={isEditChannelOpen}
        form={channelForm}
        errors={channelFormErrors}
        saving={saving}
        onOpenChange={(open) => {
          if (!open) {
            if (
              channelFormDirty &&
              !window.confirm(t("notifications.form.discardChanges"))
            ) {
              return;
            }
            setIsAddChannelOpen(false);
            setIsEditChannelOpen(false);
          }
        }}
        onFormChange={setChannelForm}
        onSave={handleSaveChannel}
      />
      <DeleteConfirmationDialog
        open={isDeleteChannelOpen}
        title={t("notifications.channels.deleteConfirmTitle")}
        description={t("notifications.channels.deleteConfirmMessage")}
        saving={saving}
        onOpenChange={setIsDeleteChannelOpen}
        onConfirm={handleConfirmDeleteChannel}
      />
      <TemplateDialog
        open={isTemplateDialogOpen}
        editing={selectedTemplate !== null}
        form={templateForm}
        saving={saving}
        onOpenChange={(open) => {
          if (
            !open &&
            templateFormDirty &&
            !window.confirm(t("notifications.form.discardChanges"))
          ) {
            return;
          }
          setIsTemplateDialogOpen(open);
        }}
        onFormChange={setTemplateForm}
        onSave={handleSaveTemplate}
      />
      <DeleteConfirmationDialog
        open={isDeleteTemplateOpen}
        title={t("notifications.templates.deleteConfirmTitle")}
        description={t("notifications.templates.deleteConfirmMessage")}
        saving={saving}
        onOpenChange={setIsDeleteTemplateOpen}
        onConfirm={handleConfirmDeleteTemplate}
      />
    </Box>
  );
};

export default NotificationsConfig;
