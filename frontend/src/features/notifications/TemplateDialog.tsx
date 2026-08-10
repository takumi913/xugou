import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Box, Flex, Text } from "@/components/ui/layout";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@/components/ui";
import type { NotificationTemplateForm } from "./form-contract";

interface TemplateDialogProps {
  open: boolean;
  editing: boolean;
  form: NotificationTemplateForm;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onFormChange: (form: NotificationTemplateForm) => void;
  onSave: () => void;
}

const templateVariables = [
  { value: "${name}", key: "name" },
  { value: "${status}", key: "status" },
  { value: "${previous_status}", key: "previous_status" },
  { value: "${time}", key: "time" },
  { value: "${url}", key: "url" },
  { value: "${response_time}", key: "response_time" },
  { value: "${status_code}", key: "status_code" },
  { value: "${expected_status}", key: "expected_status" },
  { value: "${error}", key: "error" },
  { value: "${details}", key: "details" },
  { value: "${hostname}", key: "hostname" },
  { value: "${ip_addresses}", key: "ip_addresses" },
  { value: "${os}", key: "os" },
] as const;

export default function TemplateDialog({
  open,
  editing,
  form,
  saving,
  onOpenChange,
  onFormChange,
  onSave,
}: TemplateDialogProps) {
  const { t } = useTranslation();
  const contentTextAreaRef = useRef<HTMLTextAreaElement>(null);

  const insertVariable = (variable: string) => {
    const textarea = contentTextAreaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    onFormChange({
      ...form,
      content:
        textarea.value.substring(0, start) +
        variable +
        textarea.value.substring(end),
    });
    requestAnimationFrame(() => {
      textarea.focus();
      const cursor = start + variable.length;
      textarea.setSelectionRange(cursor, cursor);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>
          {editing
            ? t("notifications.templates.edit")
            : t("notifications.templates.add")}
        </DialogTitle>
        <Flex direction="column" gap="4" mt="4">
          <Input
            className="h-10"
            aria-label={t("notifications.templates.name")}
            placeholder={t("notifications.templates.name")}
            value={form.name}
            onChange={(event) =>
              onFormChange({ ...form, name: event.target.value })
            }
          />
          <Select
            value={form.type}
            onValueChange={(value) =>
              onFormChange({
                ...form,
                type: value as NotificationTemplateForm["type"],
              })
            }
          >
            <SelectTrigger aria-label={t("notifications.channels.type")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="monitor">
                {t("notifications.settings.monitors")}
              </SelectItem>
              <SelectItem value="agent">
                {t("notifications.settings.agents")}
              </SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="h-10"
            aria-label={t("notifications.templates.subject")}
            placeholder={t("notifications.templates.subject")}
            value={form.subject}
            onChange={(event) =>
              onFormChange({ ...form, subject: event.target.value })
            }
          />
          <Textarea
            ref={contentTextAreaRef}
            aria-label={t("notifications.templates.content")}
            placeholder={t("notifications.templates.content")}
            value={form.content}
            onChange={(event) =>
              onFormChange({ ...form, content: event.target.value })
            }
            rows={8}
          />
          <Box>
            <Text size="2" weight="medium" mb="2">
              {t("notifications.templates.variables")}
            </Text>
            <Flex wrap="wrap" gap="2">
              {templateVariables.map((variable) => (
                <Button
                  key={variable.value}
                  type="button"
                  size="sm"
                  variant="secondary"
                  // 保留 textarea 的 selectionStart/selectionEnd，避免鼠标按下时
                  // 焦点切换到变量按钮并把插入点重置。
                  onPointerDown={(event) => {
                    event.preventDefault();
                    insertVariable(variable.value);
                  }}
                  onClick={(event) => {
                    // 键盘激活没有 pointerdown，detail=0 时补执行一次。
                    if (event.detail === 0) insertVariable(variable.value);
                  }}
                >
                  {t(`notifications.variables.${variable.key}`)}
                </Button>
              ))}
            </Flex>
          </Box>
        </Flex>
        <Flex gap="3" mt="4" justify="end">
          <DialogClose asChild>
            <Button variant="ghost">{t("common.cancel")}</Button>
          </DialogClose>
          <Button onClick={onSave} disabled={saving}>
            {saving ? t("common.savingChanges") : t("common.save")}
          </Button>
        </Flex>
      </DialogContent>
    </Dialog>
  );
}
