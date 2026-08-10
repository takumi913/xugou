/**
 * 应用配置
 */

const runtimeEnv = (
  import.meta as ImportMeta & {
    env?: Record<string, string | undefined>;
  }
).env ?? {};

// 优先从环境变量获取API基础URL
export const ENV_API_BASE_URL = runtimeEnv.VITE_API_BASE_URL;

// 优先从环境变量获取API请求超时时间
export const ENV_API_TIMEOUT = runtimeEnv.VITE_API_TIMEOUT || 60000;

// GitHub 仓库（owner/repo）：Footer 新版检测请求该仓库的 releases API，fork 后改这里
export const GITHUB_REPO = "zaunist/xugou";

// 应用版本号：构建时由 vite.config.ts define 注入（读 package.json version）
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";
