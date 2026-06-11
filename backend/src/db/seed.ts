import { Hono } from "hono";
import bcrypt from "bcryptjs";
import { runMigrations } from "./migration";
import {
  users,
  notificationTemplates,
  notificationChannels,
  notificationSettings,
  statusPageConfig,
  statusPageMonitors,
  statusPageAgents,
  monitors,
  agents,
  settings, // 导入 settings
} from "./schema";
import { db } from "../config";
import { eq, desc } from "drizzle-orm";
import { Bindings } from "../models";

const seed = new Hono<{}>();

// 检查并初始化数据库
export async function checkAndInitializeDatabase(d1: Bindings["DB"]): Promise<{
  initialized: boolean;
  message: string;
}> {
  try {
    // 1. 执行迁移
    await runMigrations(d1);

    // 2. 初始化基础数据（如果需要）
    await createAdminUser();
    await createNotificationTemplates();
    await createNotificationChannelsAndSettings();
    await createDefaultStatusPage();
    await createDefaultSettings(); // 新增

    return {
      initialized: true,
      message: "数据库初始化成功",
    };
  } catch (error) {
    return {
      initialized: false,
      message: `数据库初始化失败: ${error}`,
    };
  }
}

// 创建管理员用户
export async function createAdminUser(): Promise<void> {
  const adminUser = await db
    .select()
    .from(users)
    .where(eq(users.username, "admin"));

  // 如果不存在管理员用户，则创建一个
  if (adminUser.length === 0) {
    const hashedPassword = await bcrypt.hash("admin123", 10);
    const now = new Date().toISOString();

    await db.insert(users).values({
      id: 1,
      username: "admin",
      password: hashedPassword,
      email: "admin@mdzz.uk",
      role: "admin",
      created_at: now,
      updated_at: now,
    });
  }
}

// 添加通知模板初始化函数
export async function createNotificationTemplates(): Promise<void> {
  // 检查是否已有通知模板

  const existingTemplates = await db.select().from(notificationTemplates);

  if (existingTemplates.length === 0) {
    const now = new Date().toISOString();
    const userId = 1; // 管理员用户ID

    await db.insert(notificationTemplates).values({
      id: 1,
      name: "Monitor监控模板",
      type: "monitor",
      subject: "【${status}】${name} 监控状态变更",
      content:
        "🔔 网站监控状态变更通知\n\n📊 服务: ${name}\n🔄 状态: ${status} (之前: ${previous_status})\n🕒 时间: ${time}\n\n🔗 地址: ${url}\n⏱️ 响应时间: ${response_time}\n📝 实际状态码: ${status_code}\n🎯 期望状态码: ${expected_status}\n\n❗ 错误信息: ${error}",
      is_default: 1,
      created_by: userId,
      created_at: now,
      updated_at: now,
    });

    await db.insert(notificationTemplates).values({
      id: 2,
      name: "Agent监控模板",
      type: "agent",
      subject: "【${status}】${name} 客户端状态变更",
      content:
        "🔔 客户端状态变更通知\n\n📊 主机: ${name}\n🔄 状态: ${status} (之前: ${previous_status})\n🕒 时间: ${time}\n\n🖥️ 主机信息:\n  主机名: ${hostname}\n  IP地址: ${ip_addresses}\n  操作系统: ${os}\n\n❗ 错误信息: ${error}",
      is_default: 1,
      created_by: userId,
      created_at: now,
      updated_at: now,
    });
  }
}

// 添加通知渠道和设置初始化函数
export async function createNotificationChannelsAndSettings(): Promise<void> {
  // 检查是否已有通知渠道
  const existingChannels = await db.select().from(notificationChannels);

  if (existingChannels.length === 0) {
    const now = new Date().toISOString();
    const userId = 1; // 管理员用户ID

    await db.insert(notificationChannels).values({
      id: 1,
      name: "测试Bot(https://t.me/xugou_bot)",
      type: "telegram",
      config:
        '{"botToken": "8538953065:AAG51lJ31MNLWe3na5wai4SBRiZ8T-sOC3c", "chatId": "1111111111"}',
      enabled: 1,
      created_by: userId,
      created_at: now,
      updated_at: now,
    });
  }

  // 检查是否已有通知设置
  const existingSettings = await db.select().from(notificationSettings);

  if (existingSettings.length === 0) {
    const now = new Date().toISOString();
    const userId = 1; // 管理员用户ID

    await db.insert(notificationSettings).values({
      id: 1,
      user_id: userId,
      target_type: "global-monitor",
      enabled: 0,
      on_down: 1,
      on_recovery: 1,
      cooldown_minutes: 30,
      channels: "[1]", // channels (只有Telegram)
      created_at: now,
      updated_at: now,
    });

    await db.insert(notificationSettings).values({
      id: 2,
      user_id: userId,
      target_type: "global-agent",
      enabled: 0,
      on_down: 1,
      on_recovery: 1,
      on_cpu_threshold: 1,
      cpu_threshold: 80,
      on_memory_threshold: 1,
      memory_threshold: 80,
      on_disk_threshold: 1,
      disk_threshold: 90,
      cooldown_minutes: 30,
      channels: "[1]", // channels (只有Telegram)
      created_at: now,
      updated_at: now,
    });
  }
}

// 创建默认状态页配置
export async function createDefaultStatusPage(): Promise<void> {
  // 检查是否已有状态页配置
  const existingConfig = await db.select().from(statusPageConfig);

  if (existingConfig.length === 0) {
    const now = new Date().toISOString();
    const userId = 1; // 管理员用户ID

    // 创建配置
    await db.insert(statusPageConfig).values({
      user_id: userId,
      title: "系统状态",
      description: "实时监控系统运行状态",
      logo_url: "",
      custom_css: "",
      created_at: now,
      updated_at: now,
    });

    // 获取配置ID
    const config = await db
      .select()
      .from(statusPageConfig)
      .orderBy(desc(statusPageConfig.id))
      .limit(1);

    const configId = config[0].id;

    if (configId) {
      // 关联所有监控项
      const allmonitors = await db.select().from(monitors);

      if (allmonitors) {
        for (const monitor of allmonitors) {
          await db.insert(statusPageMonitors).values({
            config_id: configId,
            monitor_id: monitor.id,
          });
        }

        // 关联所有客户端
        const allAgents = await db.select().from(agents);

        if (allAgents) {
          for (const agent of allAgents) {
            await db.insert(statusPageAgents).values({
              config_id: configId,
              agent_id: agent.id,
            });
          }
        }
      }
    }
  }
}

// 新增：创建默认的应用设置
export async function createDefaultSettings(): Promise<void> {
  const registrationSetting = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "allow_new_user_registration"));

  if (registrationSetting.length === 0) {
    await db.insert(settings).values({
      key: "allow_new_user_registration",
      value: "false", // 默认不允许新用户注册
    });
  }
}

export { seed };
