import assert from "node:assert/strict";
import {
  agentRegisterSchema,
  agentStatusSchema,
  authCredentialsSchema,
  monitorSchema,
  notificationSettingsSchema,
  registerSchema,
  statusPageConfigSchema,
  userCreateSchema,
} from "../src/api/schemas";
import {
  canAccessOwnedResource,
  dedupeResourceIds,
  getMissingResourceIds,
} from "../src/utils/access";

const expectValid = (name: string, result: { success: boolean }) => {
  assert.equal(result.success, true, `${name} should be valid`);
};

const expectInvalid = (name: string, result: { success: boolean }) => {
  assert.equal(result.success, false, `${name} should be invalid`);
};

expectValid(
  "register payload",
  registerSchema.safeParse({
    username: "admin",
    password: "admin123",
    email: "admin@example.com",
  })
);
expectInvalid(
  "register payload with invalid email",
  registerSchema.safeParse({
    username: "admin",
    password: "admin123",
    email: "not-email",
  })
);

expectValid(
  "login payload",
  authCredentialsSchema.safeParse({
    username: "admin",
    password: "admin123",
  })
);
expectInvalid("login payload without password", authCredentialsSchema.safeParse({ username: "admin" }));

expectValid(
  "monitor payload",
  monitorSchema.safeParse({
    name: "API",
    url: "https://example.com/health",
    method: "GET",
    interval: 60,
    timeout: 5000,
    expected_status: 200,
    headers: "{}",
    active: true,
  })
);
expectInvalid(
  "monitor payload with invalid status",
  monitorSchema.safeParse({
    name: "API",
    url: "https://example.com/health",
    method: "GET",
    interval: 60,
    timeout: 5000,
    expected_status: 99,
    headers: "{}",
  })
);

expectValid(
  "agent register payload",
  agentRegisterSchema.safeParse({
    token: "agent-token",
    name: "server-1",
    hostname: "server-1",
    ip_addresses: ["127.0.0.1"],
    os: "linux",
    version: "1.0.0",
  })
);
expectInvalid("agent register payload without token", agentRegisterSchema.safeParse({ name: "server-1" }));

expectValid(
  "agent status payload",
  agentStatusSchema.safeParse({
    token: "agent-token",
    hostname: "server-1",
    ip_addresses: ["127.0.0.1"],
    cpu: { usage: 12, cores: 4, model_name: "Apple M" },
    memory: { total: 100, used: 50, free: 50, usage_rate: 50 },
    load: { load1: 1, load5: 1, load15: 1 },
    disks: [{ device: "/dev/disk1", usage_rate: 40 }],
    network: [{ interface: "en0", bytes_sent: 1, bytes_recv: 2 }],
  })
);
expectInvalid("agent status payload without token", agentStatusSchema.safeParse({ cpu: { usage: 12 } }));

expectValid(
  "status page payload",
  statusPageConfigSchema.safeParse({
    title: "Status",
    description: "Service status",
    logoUrl: "",
    customCss: "",
    monitors: [1],
    agents: [1],
  })
);
expectInvalid(
  "status page payload with invalid monitor id",
  statusPageConfigSchema.safeParse({
    title: "Status",
    description: "Service status",
    monitors: [0],
    agents: [],
  })
);

expectValid(
  "notification settings payload",
  notificationSettingsSchema.safeParse({
    target_type: "global-agent",
    enabled: true,
    channels: [1],
    cooldown_minutes: 30,
  })
);
expectInvalid(
  "notification settings payload with invalid cooldown",
  notificationSettingsSchema.safeParse({
    target_type: "global-agent",
    enabled: true,
    channels: [1],
    cooldown_minutes: 1441,
  })
);

expectValid(
  "user create payload",
  userCreateSchema.safeParse({
    username: "alice",
    password: "password123",
    email: "alice@example.com",
    role: "manager",
  })
);
expectInvalid(
  "user create payload with invalid role",
  userCreateSchema.safeParse({
    username: "alice",
    password: "password123",
    role: "owner",
  })
);

const ownedAgent = {
  id: 1,
  created_by: 10,
} as any;

assert.equal(
  canAccessOwnedResource(ownedAgent, 10, "user"),
  true,
  "agent owner should access own agent"
);
assert.equal(
  canAccessOwnedResource(ownedAgent, 11, "user"),
  false,
  "non-owner should not access another user's agent"
);
assert.equal(
  canAccessOwnedResource(ownedAgent, 11, "admin"),
  true,
  "admin should access cross-user agent"
);
assert.equal(
  canAccessOwnedResource(null, 10, "admin"),
  false,
  "missing agent should not be accessible"
);

assert.deepEqual(
  dedupeResourceIds([1, 1, 2, 0, -1, 3.5, 2]),
  [1, 2],
  "status page resource IDs should be unique positive integers"
);
assert.deepEqual(
  getMissingResourceIds([1, 2, 3], [1, 3]),
  [2],
  "status page validation should identify inaccessible resources"
);
