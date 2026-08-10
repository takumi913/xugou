import { expect, test, type APIResponse, type Page } from "@playwright/test";

type NotificationConfigResponse = {
  data: {
    channels: Array<{
      id: string;
      name: string;
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
    settings: {
      monitors: { enabled: boolean; channels: number[] };
    };
  };
};

type MonitorCreateResponse = { data: { id: number; name: string } };
type ResourceSettingsResponse = {
  data: Array<{
    id: number;
    target_type: "monitor" | "agent";
    setting: { enabled: boolean } | null;
  }>;
};

async function expectSuccessfulJson<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

async function login(page: Page) {
  const response = await page.request.post("/api/v2/session/login", {
    headers: { Origin: "http://127.0.0.1:4174" },
    data: { username: "admin", password: "test-initial-password" },
  });
  await expectSuccessfulJson(response);
}

async function csrfHeaders(page: Page) {
  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === "xugou_csrf"
  )?.value;
  expect(csrf).toBeTruthy();
  return {
    Origin: "http://127.0.0.1:4174",
    "X-CSRF-Token": csrf!,
  };
}

test("真实 Worker、D1 与浏览器完成渠道和 Bulk 设置闭环", async ({ page }) => {
  await login(page);
  await page.addInitScript(() => {
    localStorage.setItem("i18nextLng", "zh-CN");
    localStorage.setItem("theme", "mono");
  });
  await page.goto("/notifications");
  await expect(page.getByRole("heading", { name: "通知配置" })).toBeVisible();

  await page.getByRole("tab", { name: "通知渠道" }).click();
  await page.getByRole("button", { name: "添加渠道" }).click();
  const createDialog = page.getByRole("dialog", { name: "添加渠道" });
  await createDialog.getByLabel("渠道名称").fill("Live E2E Telegram");
  await createDialog.getByLabel("Bot Token").fill("123456789:live-e2e-token");
  await createDialog.getByLabel("Chat ID").fill("-100123456789");
  await createDialog.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("通知渠道创建成功")).toBeVisible();

  let config = await expectSuccessfulJson<NotificationConfigResponse>(
    await page.request.get("/api/v2/notifications")
  );
  const channel = config.data.channels.find(
    (item) => item.name === "Live E2E Telegram"
  );
  expect(channel).toMatchObject({ enabled: true });
  expect(JSON.stringify(channel?.config)).not.toContain("live-e2e-token");

  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editDialog = page.getByRole("dialog", { name: "编辑通知渠道" });
  await editDialog.getByLabel("启用通知渠道").click();
  await editDialog.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("通知渠道更新成功")).toBeVisible();

  config = await expectSuccessfulJson<NotificationConfigResponse>(
    await page.request.get("/api/v2/notifications")
  );
  expect(
    config.data.channels.find((item) => item.id === channel?.id)?.enabled
  ).toBe(false);

  await page.getByRole("tab", { name: "通知设置" }).click();
  const monitorToggle = page.getByLabel("API监控器通知");
  const expectedEnabled = !(await monitorToggle.isChecked());
  await monitorToggle.click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("通知设置保存成功")).toBeVisible();

  config = await expectSuccessfulJson<NotificationConfigResponse>(
    await page.request.get("/api/v2/notifications")
  );
  expect(config.data.settings.monitors.enabled).toBe(expectedEnabled);

  const monitorResponse = await page.request.post("/api/v2/monitors", {
    headers: await csrfHeaders(page),
    data: {
      name: "Live E2E Monitor",
      url: "https://monitor.example.test/health",
      method: "GET",
      interval_seconds: 300,
      timeout_ms: 10_000,
      expected_status: 200,
      headers: {},
      body: null,
      active: true,
    },
  });
  const monitor = await expectSuccessfulJson<MonitorCreateResponse>(
    monitorResponse
  );

  await page.reload();
  await page.getByRole("tab", { name: "API监控配置" }).click();
  const resourceToggle = page.getByLabel("Live E2E Monitor");
  await expect(resourceToggle).toBeVisible();
  await resourceToggle.click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("通知设置保存成功")).toBeVisible();

  const resources = await expectSuccessfulJson<ResourceSettingsResponse>(
    await page.request.get(
      "/api/v2/notifications/resource-settings?target_type=monitor&limit=25"
    )
  );
  expect(
    resources.data.find((resource) => resource.id === monitor.data.id)?.setting
  ).toMatchObject({ enabled: true });
});
