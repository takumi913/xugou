import { PlusIcon } from "@radix-ui/react-icons";
import { useTranslation } from "react-i18next";
import type { NotificationChannel } from "@/types/notification";
import { Box, Flex, Text } from "@/components/ui/layout";
import { Button } from "@/components/ui";

interface ChannelsPanelProps {
  channels: NotificationChannel[];
  testingChannelId: number | null;
  onAdd: () => void;
  onEdit: (channel: NotificationChannel) => void;
  onDelete: (channelId: number) => void;
  onTest: (channelId: number) => void;
}

export default function ChannelsPanel({
  channels,
  testingChannelId,
  onAdd,
  onEdit,
  onDelete,
  onTest,
}: ChannelsPanelProps) {
  const { t } = useTranslation();
  return (
    <Flex direction="column" gap="2">
      <Text className="text-sm text-[var(--text-secondary)]">
        {t("notifications.channels.tabDescription")}
      </Text>
      <Box p="2">
        <Flex className="mb-2 items-center justify-between">
          <Text className="text-lg">{t("notifications.channels.title")}</Text>
          <Button className="ml-auto" variant="secondary" onClick={onAdd}>
            <PlusIcon width="16" height="16" />
            {t("notifications.channels.add")}
          </Button>
        </Flex>
        <Flex py="2" direction="column" gap="2">
          <Text className="mb-3 text-[var(--text-secondary)]">
            {t("notifications.channels.description")}
          </Text>
          {channels.length === 0 ? (
            <Text color="gray">{t("notifications.channels.noChannels")}</Text>
          ) : (
            <Flex direction="column" gap="2">
              {channels.map((channel) => (
                <div key={channel.id} className="config-section">
                  <Flex className="items-center justify-between">
                    <Flex direction="column" gap="1" className="grow">
                      <Text className="break-all text-lg">{channel.name}</Text>
                      <Text className="text-xs text-[var(--text-secondary)]">
                        {t(`notifications.channels.type.${channel.type}`)}
                      </Text>
                    </Flex>
                    <Flex gap="2">
                      <Button
                        variant="ghost"
                        onClick={() => onTest(channel.id)}
                        disabled={testingChannelId === channel.id}
                      >
                        {testingChannelId === channel.id
                          ? t("notifications.channels.testing")
                          : t("notifications.channels.test")}
                      </Button>
                      <Button variant="ghost" onClick={() => onEdit(channel)}>
                        {t("common.edit")}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => onDelete(channel.id)}
                      >
                        {t("common.delete")}
                      </Button>
                    </Flex>
                  </Flex>
                </div>
              ))}
            </Flex>
          )}
        </Flex>
      </Box>
    </Flex>
  );
}
