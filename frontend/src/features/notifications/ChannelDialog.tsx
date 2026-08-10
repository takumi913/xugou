import { useTranslation } from "react-i18next";
import { Box, Flex, Text } from "@/components/ui/layout";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@/components/ui";
import {
  notificationChannelTypes,
  type ChannelConfigForm,
  type ChannelForm,
  type ChannelFormErrorKey,
  type ChannelFormErrors,
  type NotificationChannelType,
} from "./form-contract";

interface ChannelDialogProps {
  open: boolean;
  editing: boolean;
  form: ChannelForm;
  errors: ChannelFormErrors;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onFormChange: (form: ChannelForm) => void;
  onSave: () => void;
}

interface ConfigField {
  key: keyof ChannelConfigForm;
  labelKey?: string;
  label?: string;
  placeholder: string;
  errorKey?: ChannelFormErrorKey;
}

const configFields: Record<NotificationChannelType, ConfigField[]> = {
  telegram: [
    {
      key: "botToken",
      label: "Bot Token",
      placeholder: "123456789:ABCdef...",
      errorKey: "botToken",
    },
    {
      key: "chatId",
      label: "Chat ID",
      placeholder: "-100123456789",
      errorKey: "chatId",
    },
  ],
  resend: [
    {
      key: "apiKey",
      labelKey: "apiKey",
      placeholder: "re_123...",
      errorKey: "apiKey",
    },
    {
      key: "from",
      labelKey: "from",
      placeholder: "onboarding@resend.dev",
      errorKey: "from",
    },
    {
      key: "to",
      labelKey: "to",
      placeholder: "user@example.com",
      errorKey: "to",
    },
  ],
  feishu: [
    {
      key: "webhookUrl",
      labelKey: "webhookUrl",
      placeholder: "https://...",
      errorKey: "webhookUrl",
    },
  ],
  wecom: [
    {
      key: "webhookUrl",
      labelKey: "webhookUrl",
      placeholder: "https://...",
      errorKey: "webhookUrl",
    },
  ],
  dingtalk: [
    {
      key: "webhook_url",
      labelKey: "webhookUrl",
      placeholder: "https://oapi.dingtalk.com/robot/send?access_token=...",
      errorKey: "webhook_url",
    },
    {
      key: "secret",
      labelKey: "secret",
      placeholder: "SEC...",
    },
  ],
  bark: [
    {
      key: "server_url",
      labelKey: "serverUrl",
      placeholder: "https://api.day.app",
    },
    {
      key: "device_key",
      labelKey: "deviceKey",
      placeholder: "abcDEF123...",
      errorKey: "device_key",
    },
    { key: "sound", labelKey: "sound", placeholder: "alarm" },
    { key: "group", labelKey: "group", placeholder: "XUGOU" },
  ],
  serverchan: [
    {
      key: "send_key",
      labelKey: "sendKey",
      placeholder: "SCT...",
      errorKey: "send_key",
    },
  ],
  wxpusher: [
    {
      key: "app_token",
      labelKey: "appToken",
      placeholder: "AT_...",
      errorKey: "app_token",
    },
    {
      key: "uids",
      labelKey: "uids",
      placeholder: "UID_xxx,UID_yyy",
    },
    {
      key: "topic_ids",
      labelKey: "topicIds",
      placeholder: "123,456",
    },
  ],
  gotify: [
    {
      key: "server_url",
      labelKey: "serverUrl",
      placeholder: "https://gotify.example.com",
      errorKey: "server_url",
    },
    {
      key: "app_token",
      labelKey: "appToken",
      placeholder: "A....",
      errorKey: "app_token",
    },
    { key: "priority", labelKey: "priority", placeholder: "5" },
  ],
  onebot: [
    {
      key: "api_url",
      labelKey: "onebotApiUrl",
      placeholder: "http://127.0.0.1:3000",
      errorKey: "api_url",
    },
    {
      key: "access_token",
      labelKey: "onebotAccessToken",
      placeholder: "token...",
    },
    {
      key: "target_id",
      labelKey: "onebotTargetId",
      placeholder: "10000",
      errorKey: "target_id",
    },
  ],
};

export default function ChannelDialog({
  open,
  editing,
  form,
  errors,
  saving,
  onOpenChange,
  onFormChange,
  onSave,
}: ChannelDialogProps) {
  const { t } = useTranslation();

  const updateConfig = (key: keyof ChannelConfigForm, value: string) => {
    onFormChange({
      ...form,
      config: { ...form.config, [key]: value },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogTitle>
          {editing
            ? t("notifications.channels.edit")
            : t("notifications.channels.add")}
        </DialogTitle>
        <DialogDescription className="mb-4 text-sm text-[var(--text-secondary)]">
          {t("notifications.channels.dialogDescription")}
        </DialogDescription>
        <Flex direction="column" gap="5">
          <Box>
            <label
              htmlFor="notification-channel-name"
              className="mb-2 block text-sm font-bold"
            >
              {t("notifications.channels.name")}
            </label>
            <Input
              id="notification-channel-name"
              className="h-10"
              placeholder={t("notifications.channels.name")}
              value={form.name}
              aria-invalid={Boolean(errors.name)}
              onChange={(event) =>
                onFormChange({ ...form, name: event.target.value })
              }
            />
            {errors.name && (
              <Text size="1" color="red">
                {errors.name}
              </Text>
            )}
          </Box>

          <Box>
            <label className="mb-2 block text-sm font-bold">
              {t("notifications.channels.type")}
            </label>
            <Select
              value={form.type}
              onValueChange={(value) =>
                onFormChange({
                  ...form,
                  type: value as NotificationChannelType,
                })
              }
            >
              <SelectTrigger className="h-10" aria-label={t("notifications.channels.type")}>
                <SelectValue placeholder={t("notifications.channels.type")} />
              </SelectTrigger>
              <SelectContent>
                {notificationChannelTypes.map((type) => (
                  <SelectItem key={type} value={type}>
                    {t(`notifications.channels.type.${type}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Box>

          <Flex align="center" justify="between" className="config-section">
            <Text>{t("notifications.channels.enabled")}</Text>
            <Switch
              checked={form.enabled}
              aria-label={t("notifications.channels.enabled")}
              onCheckedChange={(enabled) => onFormChange({ ...form, enabled })}
            />
          </Flex>

          <div className="config-section">
            <Flex direction="column" gap="4">
              {configFields[form.type].map((field) => {
                const inputId = `notification-channel-${field.key}`;
                const error = field.errorKey ? errors[field.errorKey] : "";
                return (
                  <Box key={field.key}>
                    <label
                      htmlFor={inputId}
                      className="mb-2 block text-sm font-bold"
                    >
                      {field.label ??
                        t(`notifications.channels.${field.labelKey}`)}
                    </label>
                    <Input
                      id={inputId}
                      className="h-10"
                      placeholder={field.placeholder}
                      value={form.config[field.key]}
                      aria-invalid={Boolean(error)}
                      onChange={(event) =>
                        updateConfig(field.key, event.target.value)
                      }
                    />
                    {error && (
                      <Text size="1" color="red">
                        {error}
                      </Text>
                    )}
                  </Box>
                );
              })}

              {form.type === "wxpusher" && errors.wxpusherTarget && (
                <Text size="1" color="red">
                  {errors.wxpusherTarget}
                </Text>
              )}

              {form.type === "onebot" && (
                <Box>
                  <label className="mb-2 block text-sm font-bold">
                    {t("notifications.channels.onebotMessageType")}
                  </label>
                  <Select
                    value={form.config.message_type}
                    onValueChange={(value) =>
                      updateConfig("message_type", value)
                    }
                  >
                    <SelectTrigger
                      className="h-10"
                      aria-label={t(
                        "notifications.channels.onebotMessageType"
                      )}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="private">
                        {t("notifications.channels.onebotPrivate")}
                      </SelectItem>
                      <SelectItem value="group">
                        {t("notifications.channels.onebotGroup")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </Box>
              )}
            </Flex>
          </div>
        </Flex>
        <Flex gap="3" mt="5" justify="end">
          <DialogClose asChild>
            <Button variant="secondary">{t("common.cancel")}</Button>
          </DialogClose>
          <Button onClick={onSave} disabled={saving}>
            {saving ? t("common.savingChanges") : t("common.save")}
          </Button>
        </Flex>
      </DialogContent>
    </Dialog>
  );
}
