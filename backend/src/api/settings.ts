import { Hono } from "hono";
import { JwtPayload } from "../types";
import { Bindings } from "../models/db";
import * as SettingsService from "../services/SettingsService";
import { jwtMiddleware } from "../middlewares";
import { allowRegistrationSchema, badRequest } from "./schemas";

const settings = new Hono<{ Bindings: Bindings; Variables: { jwtPayload: JwtPayload } }>();

// 公开端点，用于检查是否允许注册
settings.get("/allow_new_user_registration", async (c) => {
    const isAllowed = await SettingsService.getAllowNewUserRegistration();
    return c.json({ success: true, allow: isAllowed });
});

// --- 以下为需要管理员权限的路由 ---
settings.use("/*", jwtMiddleware);

// 获取所有设置
settings.get("/", async (c) => {
    const payload = c.get("jwtPayload") as JwtPayload;
    if (payload.role !== 'admin') {
        return c.json({ success: false, message: '无权访问' }, 403);
    }
    const result = await SettingsService.getAllSettings();
    return c.json(result);
});

// 更新新用户注册设置
settings.put("/allow_new_user_registration", async (c) => {
    const payload = c.get("jwtPayload") as JwtPayload;
    if (payload.role !== 'admin') {
        return c.json({ success: false, message: '无权操作' }, 403);
    }
    const parsed = allowRegistrationSchema.safeParse(await c.req.json());
    if (!parsed.success) {
        return c.json(badRequest("无效的参数"), 400);
    }
    const result = await SettingsService.updateAllowNewUserRegistration(parsed.data.allow);
    return c.json(result);
});

export { settings };
