import assert from "node:assert/strict";
import {
  monitorFormSchema,
  monitorFormToMutation,
  type MonitorFormValues,
} from "../src/features/monitors/form-contract";
import {
  agentFormSchema,
  agentFormToUpdate,
  type AgentFormValues,
} from "../src/features/agents/form-contract";
import {
  channelFormToCommand,
  emptyChannelForm,
  notificationChannelFormSchema,
  notificationChannelToForm,
  notificationTemplateFormSchema,
} from "../src/features/notifications/form-contract";

const monitor: MonitorFormValues = {
  name: "health",
  url: "https://example.test/health",
  method: "PATCH",
  intervalMinutes: 5,
  timeoutSeconds: 2.5,
  expectedStatus: 204,
  headers: [
    { key: "Content-Type", value: "application/json" },
    { key: "X-Trace", value: "fixture" },
  ],
  body: "{}",
};
assert.equal(monitorFormSchema.safeParse(monitor).success, true);
assert.deepEqual(monitorFormToMutation(monitor), {
  name: "health",
  url: "https://example.test/health",
  method: "PATCH",
  interval_seconds: 300,
  timeout_ms: 2500,
  expected_status: 204,
  headers: {
    "Content-Type": "application/json",
    "X-Trace": "fixture",
  },
  body: "{}",
});
assert.equal(
  monitorFormSchema.safeParse({
    ...monitor,
    headers: [
      { key: "Authorization", value: "a" },
      { key: "authorization", value: "b" },
    ],
  }).success,
  false,
  "header names must be unique case-insensitively"
);
assert.equal(
  monitorFormSchema.safeParse({ ...monitor, url: "file:///tmp/health" })
    .success,
  false,
  "monitor URL must use HTTP(S)"
);

const agent: AgentFormValues = {
  name: "edge-1",
  collectIntervalSeconds: "60",
  reportIntervalSeconds: "300",
  autoUpdate: true,
  groupName: "production",
  tags: "edge, hk",
  price: "9.99",
  currency: "USD",
  billingCycle: "monthly",
  expireDate: "2027-01-01",
  autoRenewal: true,
  trafficLimitGb: "1024",
  trafficResetDay: "15",
  trafficCalcType: "sum",
  isHidden: false,
};
assert.equal(agentFormSchema.safeParse(agent).success, true);
assert.deepEqual(agentFormToUpdate(agent), {
  name: "edge-1",
  collect_interval_seconds: 60,
  report_interval_seconds: 300,
  auto_update: true,
  group_name: "production",
  tags: ["edge", "hk"],
  price: 9.99,
  currency: "USD",
  billing_cycle: "monthly",
  expire_date: "2027-01-01",
  auto_renewal: true,
  traffic_limit_gb: 1024,
  traffic_reset_day: 15,
  traffic_calc_type: "sum",
  is_hidden: false,
});
assert.equal(
  agentFormSchema.safeParse({
    ...agent,
    collectIntervalSeconds: "300",
    reportIntervalSeconds: "60",
  }).success,
  false,
  "report interval must not be lower than collect interval"
);
assert.equal(
  agentFormSchema.safeParse({ ...agent, trafficResetDay: "29" }).success,
  false,
  "traffic reset day must stay in the D1 contract range"
);

const telegram = emptyChannelForm();
telegram.name = "operations";
assert.equal(
  notificationChannelFormSchema.safeParse(telegram).success,
  false,
  "Telegram requires both bot token and chat ID"
);
telegram.config.botToken = "********";
telegram.config.chatId = "-100123456789";
telegram.config.apiKey = "must-not-leak";
assert.equal(notificationChannelFormSchema.safeParse(telegram).success, true);
assert.deepEqual(channelFormToCommand(telegram), {
  name: "operations",
  type: "telegram",
  enabled: true,
  config: {
    botToken: "********",
    chatId: "-100123456789",
  },
});

const maskedTelegram = notificationChannelToForm({
  id: 7,
  name: "masked",
  type: "telegram",
  enabled: true,
  config: { botToken: "********", chatId: "-1007" },
});
assert.equal(maskedTelegram.config.botToken, "********");
assert.equal(
  channelFormToCommand(maskedTelegram).config.botToken,
  "********",
  "masked secrets must survive an unrelated channel edit"
);

const wxpusher = emptyChannelForm();
wxpusher.name = "wxpusher";
wxpusher.type = "wxpusher";
wxpusher.config.app_token = "AT_fixture";
assert.equal(
  notificationChannelFormSchema.safeParse(wxpusher).success,
  false,
  "WXPusher requires at least one UID or topic ID"
);
wxpusher.config.topic_ids = "42";
assert.equal(notificationChannelFormSchema.safeParse(wxpusher).success, true);

const onebot = emptyChannelForm();
onebot.name = "onebot";
onebot.type = "onebot";
onebot.config.api_url = "https://onebot.example.test";
onebot.config.target_id = "not-a-number";
assert.equal(
  notificationChannelFormSchema.safeParse(onebot).success,
  false,
  "OneBot target ID must be numeric"
);
onebot.config.target_id = "10000";
assert.equal(notificationChannelFormSchema.safeParse(onebot).success, true);

assert.equal(
  notificationTemplateFormSchema.safeParse({
    name: "monitor down",
    type: "monitor",
    subject: "${name} is down",
    content: "status=${status}",
  }).success,
  true
);
assert.equal(
  notificationTemplateFormSchema.safeParse({
    name: "x".repeat(129),
    type: "monitor",
    subject: "subject",
    content: "content",
  }).success,
  false,
  "template names must respect the backend contract limit"
);
assert.equal(
  notificationTemplateFormSchema.safeParse({
    name: "monitor down",
    type: "monitor",
    subject: "subject",
    content: "x".repeat(20_001),
  }).success,
  false,
  "template content must respect the backend contract limit"
);
