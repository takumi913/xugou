import { Hono, ExecutionContext } from "hono";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";

import * as seed from "./db";
import { Bindings } from "./models/db";
import * as middlewares from "./middlewares";
import * as jobs from "./jobs";
import * as api from "./api";
import * as config from "./config";

// 创建Hono应用
const app = new Hono<{ Bindings: Bindings }>();

// 中间件
app.use("*", async (c, next) => {
  if (c.env.LOG_REQUESTS === "true" || c.env.NODE_ENV === "development") {
    return logger()(c, next);
  }
  await next();
});
app.use("*", middlewares.corsMiddleware);
app.use("*", prettyJSON());
app.use("*", middlewares.jwtMiddleware);

// 公共路由
app.get("/", (c) => c.json({ message: "XUGOU API 服务正在运行" }));

// 路由注册
app.route("/api/auth", api.auth);
app.route("/api/monitors", api.monitors);
app.route("/api/agents", api.agents);
app.route("/api/users", api.users);
app.route("/api/status", api.status);
app.route("/api/notifications", api.notifications);
app.route("/api/dashboard", api.dashboard);
app.route("/api/settings", api.settings);

// 静态文件路由 - 处理所有非 API 请求，返回前端应用
app.get("*", async (c) => {
  const url = new URL(c.req.url);
  
  // 如果是 API 路由，跳过静态文件处理
  if (url.pathname.startsWith("/api/")) {
    return c.notFound();
  }
  
  try {
    // 尝试获取请求的静态文件
    const asset = await c.env.ASSETS.fetch(c.req.url);
    
    // 如果文件存在，直接返回
    if (asset.status === 200) {
      return asset;
    }
    
    // 如果文件不存在，返回 index.html 以支持 React Router
    const indexUrl = new URL("/index.html", c.req.url);
    const indexAsset = await c.env.ASSETS.fetch(indexUrl.toString());
    
    if (indexAsset.status === 200) {
      // 设置正确的 Content-Type
      const response = new Response(indexAsset.body, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache"
        }
      });
      return response;
    }
    
    return c.notFound();
  } catch (error) {
    console.error("静态文件服务错误:", error);
    return c.text("Internal Server Error", 500);
  }
});
// 数据库状态标志，用于记录数据库初始化状态
let dbInitialized = false;

// 导出 fetch 函数供 Cloudflare Workers 使用
export default {
  // 处理 HTTP 请求
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext) {

    // 如果是 OPTIONS 请求，直接处理
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: middlewares.createCorsHeaders(request, env),
      });
    }


    // 初始化 drizzle 实例
    config.initDb(env);

    // 如果数据库尚未初始化，则进行初始化检查
    if (!dbInitialized) {
      await seed.checkAndInitializeDatabase(env.DB);
      dbInitialized = true;
    }

    // 处理请求
    return app.fetch(request, env, ctx);
  },

  // 添加定时任务，每分钟执行一次监控检查和客户端状态检查
  async scheduled(event: any, env: any, ctx: any) {
    try {
      // 初始化 drizzle 实例
      config.initDb(env);
      await jobs.runScheduledTasks(event, env, ctx);
    } catch (error) {
      console.error("定时任务执行出错:", error);
    }
  },
};
