import { expect, test, type Page, type Route } from "@playwright/test";

const notificationConfig = {
  data: {
    channels: [
      {
        id: "1",
        name: "值班 Telegram",
        type: "telegram",
        config: { botToken: "********", chatId: "-100123456" },
        enabled: true,
        created_at: "2026-08-09T00:00:00.000Z",
        updated_at: "2026-08-09T00:00:00.000Z",
      },
    ],
    templates: [
      {
        id: "1",
        name: "默认监控模板",
        type: "monitor",
        subject: "${name} 状态变化",
        content: "${name}: ${previous_status} -> ${status}",
        is_default: true,
        created_at: "2026-08-09T00:00:00.000Z",
        updated_at: "2026-08-09T00:00:00.000Z",
      },
    ],
    settings: {
      monitors: {
        enabled: true,
        onDown: true,
        onRecovery: true,
        cooldownMinutes: 30,
        channels: [1],
      },
      agents: {
        enabled: true,
        onOffline: true,
        onRecovery: true,
        onCpuThreshold: true,
        cpuThreshold: 90,
        onMemoryThreshold: true,
        memoryThreshold: 85,
        onDiskThreshold: true,
        diskThreshold: 90,
        cooldownMinutes: 30,
        channels: [1],
      },
      specificMonitors: {},
      specificAgents: {},
    },
  },
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function mockApi(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("i18nextLng", "zh-CN");
    localStorage.setItem("theme", "mono");
  });
  await page.route("**/api/v2/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;

    if (pathname === "/api/v2/session/me") {
      return json(route, {
        success: true,
        user: { id: 1, username: "admin", role: "admin", email: null },
      });
    }
    if (pathname === "/api/v2/notifications" && request.method() === "GET") {
      return json(route, notificationConfig);
    }
    if (
      pathname === "/api/v2/notifications/resource-settings" &&
      request.method() === "GET"
    ) {
      return json(route, { data: [], next_cursor: null, has_more: false });
    }
    if (
      (pathname === "/api/v2/monitors" || pathname === "/api/v2/agents") &&
      request.method() === "GET"
    ) {
      return json(route, { data: [], next_cursor: null, has_more: false });
    }
    if (pathname.startsWith("/api/v2/notifications/")) {
      return json(route, { data: {}, success: true });
    }
    return json(route, {
      type: "about:blank",
      title: "Unexpected test request",
      status: 404,
      code: "NOT_FOUND",
      trace_id: "e2e",
    }, 404);
  });
}

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.goto("/notifications");
  await expect(
    page.getByRole("heading", { name: "通知配置" })
  ).toBeVisible();
});

test("渠道表单校验、dirty 保护与 Provider 字段可访问性", async ({
  page,
}) => {
  await page.getByRole("tab", { name: "通知渠道" }).click();
  await page.getByRole("button", { name: "添加渠道" }).click();

  const dialog = page.getByRole("dialog", { name: "添加渠道" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog.getByText("渠道名称为必填项")).toBeVisible();
  await expect(dialog.getByText("Bot Token为必填项")).toBeVisible();
  await expect(dialog.getByText("Chat ID为必填项")).toBeVisible();

  await dialog.getByLabel("渠道名称").fill("夜间值班");
  await dialog.getByLabel("Bot Token").fill("123456789:test-token");
  await dialog.getByLabel("Chat ID").fill("-100987654");
  await expect(dialog).toHaveScreenshot("notification-channel-dialog.png");

  page.once("dialog", (confirmation) => confirmation.dismiss());
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toBeVisible();

  page.once("dialog", (confirmation) => confirmation.accept());
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toBeHidden();
});

test("模板变量按光标插入并提交精确 Payload", async ({ page }) => {
  await page.getByRole("tab", { name: "消息模板" }).click();
  await page.getByRole("button", { name: "添加模板" }).click();

  const dialog = page.getByRole("dialog", { name: "添加模板" });
  const content = dialog.getByLabel("内容");
  await dialog.getByLabel("模板名称").fill("恢复通知");
  await dialog.getByLabel("主题").fill("服务已恢复");
  await content.fill("prefix suffix");
  await content.evaluate((element: HTMLTextAreaElement) => {
    element.focus();
    element.setSelectionRange(7, 7);
  });
  await dialog.getByRole("button", { name: "名称", exact: true }).click();
  await expect(content).toHaveValue("prefix ${name}suffix");
  await expect(dialog).toHaveScreenshot("notification-template-dialog.png");

  const requestPromise = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/v2/notifications/templates"
  );
  await dialog.getByRole("button", { name: "保存" }).click();
  const request = await requestPromise;
  expect(request.postDataJSON()).toEqual({
    name: "恢复通知",
    type: "monitor",
    subject: "服务已恢复",
    content: "prefix ${name}suffix",
    is_default: false,
  });
  await expect(dialog).toBeHidden();
});

test("新建渠道提交完整 Provider Payload", async ({ page }) => {
  await page.getByRole("tab", { name: "通知渠道" }).click();
  await page.getByRole("button", { name: "添加渠道" }).click();
  const dialog = page.getByRole("dialog", { name: "添加渠道" });
  await dialog.getByLabel("渠道名称").fill("生产值班");
  await dialog.getByLabel("Bot Token").fill("123456789:production-token");
  await dialog.getByLabel("Chat ID").fill("-100999999");
  const requestPromise = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/v2/notifications/channels"
  );
  await dialog.getByRole("button", { name: "保存" }).click();
  const request = await requestPromise;
  expect(request.postDataJSON()).toEqual({
    name: "生产值班",
    type: "telegram",
    enabled: true,
    config: { botToken: "123456789:production-token", chatId: "-100999999" },
  });
  await expect(page.getByText("通知渠道创建成功")).toBeVisible();
});

test("编辑并禁用既有通知渠道", async ({ page }) => {
  await page.getByRole("tab", { name: "通知渠道" }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑通知渠道" });
  await dialog.getByLabel("渠道名称").fill("值班 Telegram（停用）");
  await dialog.getByLabel("启用通知渠道").click();
  const requestPromise = page.waitForRequest(
    (request) =>
      request.method() === "PATCH" &&
      new URL(request.url()).pathname === "/api/v2/notifications/channels/1"
  );
  await dialog.getByRole("button", { name: "保存" }).click();
  const body = requestPromise.then((request) => request.postDataJSON());
  await expect(body).resolves.toMatchObject({
    name: "值班 Telegram（停用）",
    enabled: false,
  });
  await expect(page.getByText("通知渠道更新成功")).toBeVisible();
});

test("测试通知展示服务端诊断错误", async ({ page }) => {
  await page.route("**/api/v2/notifications/channels/1/test", (route) =>
    json(route, {
      type: "about:blank",
      title: "Provider delivery rejected",
      status: 502,
      code: "PROVIDER_REJECTED",
      trace_id: "e2e-provider",
    }, 502)
  );
  await page.getByRole("tab", { name: "通知渠道" }).click();
  await page.getByRole("button", { name: "发送测试" }).click();
  await expect(page.getByText("Provider delivery rejected")).toBeVisible();
});

test("Bulk 整体失败后保留草稿，并以同一幂等键重试", async ({ page }) => {
  const keys: string[] = [];
  let attempts = 0;
  await page.route("**/api/v2/notifications/settings/bulk", (route) => {
    attempts += 1;
    keys.push(route.request().headers()["idempotency-key"] ?? "");
    return attempts === 1
      ? json(route, {
          type: "about:blank",
          title: "Injected atomic batch failure",
          status: 500,
          code: "SETTING_BULK_SAVE_FAILED",
          trace_id: "e2e-bulk",
        }, 500)
      : json(route, { data: { ids: [1, 2], replayed: true } });
  });
  const toggle = page.getByLabel("API监控器通知");
  await toggle.click();
  const save = page.getByRole("button", { name: "保存", exact: true });
  await save.click();
  await expect(page.getByText("通知设置保存失败")).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await save.click();
  await expect(page.getByText("通知设置保存成功")).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toMatch(/^notification-settings:/);
  expect(keys[1]).toBe(keys[0]);
});

test("会话过期的 Bulk 保存跳转登录页", async ({ page }) => {
  await page.route("**/api/v2/notifications/settings/bulk", (route) =>
    json(route, {
      type: "about:blank",
      title: "Authentication required",
      status: 401,
      code: "UNAUTHORIZED",
      trace_id: "e2e-session",
    }, 401)
  );
  await page.getByLabel("API监控器通知").click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("英文移动端保持关键操作与布局可用", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("i18nextLng", "en-US"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Notification Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
});

test("通知配置关键页面视觉基线", async ({ page }) => {
  await expect(page).toHaveScreenshot("notifications-config-page.png", {
    fullPage: true,
  });
});
