import { Hono } from "hono";
import { JwtPayload } from "../types";
import { jwtMiddleware } from "../middlewares";
import {
  loginUser,
  registerUser,
  getCurrentUser,
} from "../services/AuthService";
import { Bindings } from "../models/db";
import { authCredentialsSchema, badRequest, registerSchema } from "./schemas";


const auth = new Hono<{ Bindings: Bindings; Variables: { jwtPayload: JwtPayload } }>();

// 注册路由
auth.post("/register", async (c) => {
  try {
    const parsed = registerSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(badRequest("注册参数无效"), 400);
    }

    const { username, password, email } = parsed.data;

    // 调用 AuthService 的注册方法
    const result = await registerUser(c.env, username, password, email || null);

    return c.json(
      {
        success: result.success,
        message: result.message,
        user: result.user,
      },
      result.success ? 201 : 400
    );
  } catch (error) {
    console.error("注册错误:", error);
    return c.json({ success: false, message: "注册失败" }, 500);
  }
});

// 登录路由
auth.post("/login", async (c) => {
  try {
    if (!c.env.CF_VERSION_METADATA) {
      console.error("错误: c.env.CF_VERSION_METADATA 不存在于路由处理函数中");
    }

    const parsed = authCredentialsSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(badRequest("登录参数无效"), 400);
    }

    const { username, password } = parsed.data;

    // 调用 AuthService 的登录方法
    const result = await loginUser(c.env, username, password);

    return c.json(
      {
        success: result.success,
        message: result.message,
        token: result.token,
        user: result.user,
      },
      result.success ? 200 : 401
    );
  } catch (error) {
    console.error("登录错误:", error);
    console.error(
      "错误堆栈:",
      error instanceof Error ? error.stack : "未知错误"
    );
    return c.json({ success: false, message: "登录失败" }, 500);
  }
});

// 获取当前用户信息
auth.use("/me", jwtMiddleware);

auth.get("/me", async (c) => {
  try {
    const payload = c.get("jwtPayload") as JwtPayload;

    // 调用 AuthService 的获取当前用户方法
    const result = await getCurrentUser(c.env, payload.id);

    return c.json(
      {
        success: result.success,
        message: result.message,
        user: result.user,
      },
      result.success ? 200 : 404
    );
  } catch (error) {
    console.error("获取用户信息错误:", error);
    return c.json({ success: false, message: "获取用户信息失败" }, 500);
  }
});

export { auth };
