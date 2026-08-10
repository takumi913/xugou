import { PlusIcon } from "@radix-ui/react-icons";
import { useTranslation } from "react-i18next";
import type { NotificationTemplate } from "@/types/notification";
import { Box, Flex, Heading, Text } from "@/components/ui/layout";
import { Button } from "@/components/ui";

interface TemplatesPanelProps {
  templates: NotificationTemplate[];
  onAdd: () => void;
  onEdit: (template: NotificationTemplate) => void;
  onDelete: (template: NotificationTemplate) => void;
}

export default function TemplatesPanel({
  templates,
  onAdd,
  onEdit,
  onDelete,
}: TemplatesPanelProps) {
  const { t } = useTranslation();
  return (
    <Flex direction="column" gap="2">
      <Text size="2" color="gray" mb="3">
        {t("notifications.templates.tabDescription")}
      </Text>
      <Box>
        <Flex justify="between" align="center" mb="3">
          <Heading size="3">{t("notifications.templates.title")}</Heading>
          <Button variant="secondary" onClick={onAdd}>
            <PlusIcon width="16" height="16" />
            {t("notifications.templates.add")}
          </Button>
        </Flex>
        <Text size="2" color="gray" mb="3">
          {t("notifications.templates.description")}
        </Text>
        {templates.length === 0 ? (
          <Text color="gray">{t("notifications.templates.noTemplates")}</Text>
        ) : (
          <Flex direction="column" gap="3">
            {templates.map((template) => (
              <div key={template.id} className="config-section">
                <Flex direction="column" gap="3">
                  <Flex justify="between" align="center">
                    <Flex gap="2" align="center">
                      <Text weight="medium">{template.name}</Text>
                      {template.isDefault && (
                        <Text size="1">
                          {t("notifications.templates.defaultTemplate")}
                        </Text>
                      )}
                    </Flex>
                    <Flex gap="2">
                      <Button variant="ghost" onClick={() => onEdit(template)}>
                        {t("common.edit")}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => onDelete(template)}
                        disabled={template.isDefault}
                      >
                        {t("common.delete")}
                      </Button>
                    </Flex>
                  </Flex>
                  <Box>
                    <Text size="2" weight="medium">
                      {t("notifications.templates.subject")}:
                    </Text>
                    <Text size="2">{template.subject}</Text>
                  </Box>
                  <Box>
                    <Text size="2" weight="medium">
                      {t("notifications.templates.content")}:
                    </Text>
                    <Box className="whitespace-pre-wrap break-words">
                      {template.content}
                    </Box>
                  </Box>
                </Flex>
              </div>
            ))}
          </Flex>
        )}
      </Box>
    </Flex>
  );
}
