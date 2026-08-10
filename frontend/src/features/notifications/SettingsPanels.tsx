import { useTranslation } from "react-i18next";
import type {
  NotificationResourceSetting,
  NotificationSettings,
} from "@/api/notifications";
import TagSelect, { type TagSelectOption } from "@/components/TagSelect";
import { Box, Flex, Text } from "@/components/ui/layout";
import { Input, Switch } from "@/components/ui";

type MonitorSetting = NotificationSettings["monitors"];
type AgentSetting = NotificationSettings["agents"];

interface RuleFieldsProps<T> {
  setting: T;
  channelOptions: TagSelectOption[];
  onChange: (setting: T) => void;
}

interface ToggleRowProps {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}

function ToggleRow({ checked, label, onChange }: ToggleRowProps) {
  return (
    <Flex align="center" gap="2">
      <Switch
        checked={checked}
        aria-label={label}
        onCheckedChange={onChange}
      />
      <Text size="2">{label}</Text>
    </Flex>
  );
}

interface NumberSettingProps {
  value: number;
  label: string;
  suffix: string;
  min: number;
  max: number;
  onChange: (value: number) => void;
}

function NumberSetting({
  value,
  label,
  suffix,
  min,
  max,
  onChange,
}: NumberSettingProps) {
  return (
    <Flex align="center" gap="2">
      <label className="text-sm">{label}</label>
      <Input
        className="h-8 w-24"
        type="number"
        aria-label={label}
        min={min}
        max={max}
        value={value.toString()}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          onChange(
            Number.isFinite(parsed)
              ? Math.max(min, Math.min(max, parsed))
              : min
          );
        }}
      />
      <Text size="2">{suffix}</Text>
    </Flex>
  );
}

function ChannelSetting({
  options,
  selectedIds,
  onChange,
}: {
  options: TagSelectOption[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <Box>
      <Text size="2" weight="medium" mb="2">
        {t("notifications.specificSettings.channels")}
      </Text>
      <TagSelect
        options={options}
        selectedIds={selectedIds}
        onChange={onChange}
      />
    </Box>
  );
}

function MonitorRuleFields({
  setting,
  channelOptions,
  onChange,
}: RuleFieldsProps<MonitorSetting>) {
  const { t } = useTranslation();
  return (
    <Flex direction="column" gap="3">
      <ToggleRow
        checked={setting.onDown}
        label={t("notifications.events.onDownOnly")}
        onChange={(checked) => onChange({ ...setting, onDown: checked })}
      />
      <ToggleRow
        checked={setting.onRecovery}
        label={t("notifications.events.onRecovery")}
        onChange={(checked) => onChange({ ...setting, onRecovery: checked })}
      />
      <NumberSetting
        value={setting.cooldownMinutes}
        label={t("notifications.settings.cooldownMinutes")}
        suffix={t("notifications.settings.minutes")}
        min={0}
        max={1440}
        onChange={(value) =>
          onChange({ ...setting, cooldownMinutes: value })
        }
      />
      <ChannelSetting
        options={channelOptions}
        selectedIds={setting.channels}
        onChange={(channels) => onChange({ ...setting, channels })}
      />
    </Flex>
  );
}

function ThresholdSetting({
  enabled,
  value,
  label,
  onEnabledChange,
  onValueChange,
}: {
  enabled: boolean;
  value: number;
  label: string;
  onEnabledChange: (enabled: boolean) => void;
  onValueChange: (value: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <ToggleRow checked={enabled} label={label} onChange={onEnabledChange} />
      {enabled && (
        <Flex pl="6">
          <NumberSetting
            value={value}
            label={t("notifications.threshold.label")}
            suffix={t("notifications.threshold.percent")}
            min={0}
            max={100}
            onChange={onValueChange}
          />
        </Flex>
      )}
    </>
  );
}

function AgentRuleFields({
  setting,
  channelOptions,
  onChange,
}: RuleFieldsProps<AgentSetting>) {
  const { t } = useTranslation();
  return (
    <Flex direction="column" gap="3">
      <ToggleRow
        checked={setting.onOffline}
        label={t("notifications.events.onOffline")}
        onChange={(checked) => onChange({ ...setting, onOffline: checked })}
      />
      <ToggleRow
        checked={setting.onRecovery}
        label={t("notifications.events.onRecoveryAgent")}
        onChange={(checked) => onChange({ ...setting, onRecovery: checked })}
      />
      <ThresholdSetting
        enabled={setting.onCpuThreshold}
        value={setting.cpuThreshold}
        label={t("notifications.events.onCpuThreshold")}
        onEnabledChange={(checked) =>
          onChange({ ...setting, onCpuThreshold: checked })
        }
        onValueChange={(value) =>
          onChange({ ...setting, cpuThreshold: value })
        }
      />
      <ThresholdSetting
        enabled={setting.onMemoryThreshold}
        value={setting.memoryThreshold}
        label={t("notifications.events.onMemoryThreshold")}
        onEnabledChange={(checked) =>
          onChange({ ...setting, onMemoryThreshold: checked })
        }
        onValueChange={(value) =>
          onChange({ ...setting, memoryThreshold: value })
        }
      />
      <ThresholdSetting
        enabled={setting.onDiskThreshold}
        value={setting.diskThreshold}
        label={t("notifications.events.onDiskThreshold")}
        onEnabledChange={(checked) =>
          onChange({ ...setting, onDiskThreshold: checked })
        }
        onValueChange={(value) =>
          onChange({ ...setting, diskThreshold: value })
        }
      />
      <NumberSetting
        value={setting.cooldownMinutes}
        label={t("notifications.settings.cooldownMinutes")}
        suffix={t("notifications.settings.minutes")}
        min={0}
        max={1440}
        onChange={(value) =>
          onChange({ ...setting, cooldownMinutes: value })
        }
      />
      <ChannelSetting
        options={channelOptions}
        selectedIds={setting.channels}
        onChange={(channels) => onChange({ ...setting, channels })}
      />
    </Flex>
  );
}

interface GlobalSettingsPanelProps {
  settings: Pick<NotificationSettings, "monitors" | "agents">;
  channelOptions: TagSelectOption[];
  onMonitorChange: (setting: MonitorSetting) => void;
  onAgentChange: (setting: AgentSetting) => void;
}

export function GlobalSettingsPanel({
  settings,
  channelOptions,
  onMonitorChange,
  onAgentChange,
}: GlobalSettingsPanelProps) {
  const { t } = useTranslation();
  return (
    <Flex direction="column" gap="2">
      <Text className="text-sm">
        {t("notifications.globalSettings.description")}
      </Text>
      <Box>
        <Text className="text-lg">
          {t("notifications.settings.monitors")}
        </Text>
        <div className="config-section mt-2">
          <Flex direction="column" gap="2" className="px-2">
            <Flex justify="between" align="center">
              <Box>
                <Text className="text-base">
                  {t("notifications.settings.monitors")}
                </Text>
                <Text className="text-sm text-[var(--text-secondary)]">
                  {t("notifications.settings.monitors.description")}
                </Text>
              </Box>
              <Switch
                checked={settings.monitors.enabled}
                aria-label={t("notifications.settings.monitors")}
                onCheckedChange={(enabled) =>
                  onMonitorChange({ ...settings.monitors, enabled })
                }
              />
            </Flex>
            {settings.monitors.enabled && (
              <Box pl="4">
                <MonitorRuleFields
                  setting={settings.monitors}
                  channelOptions={channelOptions}
                  onChange={onMonitorChange}
                />
              </Box>
            )}
          </Flex>
        </div>
      </Box>
      <Box>
        <Text className="mb-2 text-lg">
          {t("notifications.settings.agents")}
        </Text>
        <div className="config-section mt-2">
          <Flex direction="column" gap="4" className="px-2">
            <Flex justify="between" align="center">
              <Box>
                <Text className="text-base">
                  {t("notifications.settings.agents")}
                </Text>
                <Text className="text-sm text-[var(--text-secondary)]">
                  {t("notifications.settings.agents.description")}
                </Text>
              </Box>
              <Switch
                checked={settings.agents.enabled}
                aria-label={t("notifications.settings.agents")}
                onCheckedChange={(enabled) =>
                  onAgentChange({ ...settings.agents, enabled })
                }
              />
            </Flex>
            {settings.agents.enabled && (
              <Box pl="4">
                <AgentRuleFields
                  setting={settings.agents}
                  channelOptions={channelOptions}
                  onChange={onAgentChange}
                />
              </Box>
            )}
          </Flex>
        </div>
      </Box>
    </Flex>
  );
}

const defaultMonitorSetting = (
  global: MonitorSetting
): MonitorSetting => ({
  enabled: false,
  onDown: false,
  onRecovery: false,
  cooldownMinutes: global.cooldownMinutes,
  channels: [],
});

const defaultAgentSetting = (global: AgentSetting): AgentSetting => ({
  enabled: false,
  onOffline: false,
  onRecovery: false,
  onCpuThreshold: false,
  cpuThreshold: 90,
  onMemoryThreshold: false,
  memoryThreshold: 85,
  onDiskThreshold: false,
  diskThreshold: 90,
  cooldownMinutes: global.cooldownMinutes,
  channels: [],
});

interface SpecificMonitorsPanelProps {
  resources: NotificationResourceSetting[];
  loading: boolean;
  settings: NotificationSettings;
  channelOptions: TagSelectOption[];
  onChange: (monitorId: string, setting: MonitorSetting) => void;
}

export function SpecificMonitorsPanel({
  resources,
  loading,
  settings,
  channelOptions,
  onChange,
}: SpecificMonitorsPanelProps) {
  const { t } = useTranslation();
  if (loading) return <Text>{t("common.loading")}...</Text>;
  if (resources.length === 0) {
    return <Text color="gray">{t("monitors.noMonitors")}</Text>;
  }

  return (
    <Flex direction="column" gap="2">
      <Text size="2" color="gray" mb="3">
        {t("notifications.specificMonitors.description")}
      </Text>
      {resources.map((resource) => {
        const monitorId = resource.id.toString();
        const setting =
          settings.specificMonitors[monitorId] ??
          (resource.target_type === "monitor"
            ? (resource.setting as MonitorSetting | null)
            : null) ??
          defaultMonitorSetting(settings.monitors);
        return (
          <div key={monitorId} className="config-section">
            <Flex direction="column" gap="3">
              <Flex justify="between" align="center">
                <Flex direction="column">
                  <Text weight="medium">{resource.name}</Text>
                  <Text size="1" color="gray">
                    {resource.description ?? "—"}
                  </Text>
                </Flex>
                <Switch
                  checked={setting.enabled}
                  aria-label={resource.name}
                  onCheckedChange={(enabled) =>
                    onChange(monitorId, { ...setting, enabled })
                  }
                />
              </Flex>
              {setting.enabled && (
                <Box pl="4">
                  <MonitorRuleFields
                    setting={setting}
                    channelOptions={channelOptions}
                    onChange={(value) => onChange(monitorId, value)}
                  />
                </Box>
              )}
            </Flex>
          </div>
        );
      })}
    </Flex>
  );
}

interface SpecificAgentsPanelProps {
  resources: NotificationResourceSetting[];
  loading: boolean;
  settings: NotificationSettings;
  channelOptions: TagSelectOption[];
  onChange: (agentId: string, setting: AgentSetting) => void;
}

export function SpecificAgentsPanel({
  resources,
  loading,
  settings,
  channelOptions,
  onChange,
}: SpecificAgentsPanelProps) {
  const { t } = useTranslation();
  if (loading) return <Text>{t("common.loading")}...</Text>;
  if (resources.length === 0) {
    return <Text color="gray">{t("agents.noAgents")}</Text>;
  }

  return (
    <Flex direction="column" gap="2">
      <Text size="2" color="gray" mb="3">
        {t("notifications.specificAgents.description")}
      </Text>
      {resources.map((resource) => {
        const agentId = resource.id.toString();
        const setting =
          settings.specificAgents[agentId] ??
          (resource.target_type === "agent"
            ? (resource.setting as AgentSetting | null)
            : null) ??
          defaultAgentSetting(settings.agents);
        return (
          <div key={agentId} className="config-section">
            <Flex direction="column" gap="3">
              <Flex justify="between" align="center">
                <Flex direction="column">
                  <Text weight="medium">{resource.name}</Text>
                  <Text size="1" color="gray">
                    {resource.description ?? "—"}
                  </Text>
                </Flex>
                <Switch
                  checked={setting.enabled}
                  aria-label={resource.name}
                  onCheckedChange={(enabled) =>
                    onChange(agentId, { ...setting, enabled })
                  }
                />
              </Flex>
              {setting.enabled && (
                <Box pl="4">
                  <AgentRuleFields
                    setting={setting}
                    channelOptions={channelOptions}
                    onChange={(value) => onChange(agentId, value)}
                  />
                </Box>
              )}
            </Flex>
          </div>
        );
      })}
    </Flex>
  );
}
