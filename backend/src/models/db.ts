// 非公开 Secrets 无法由 `wrangler types` 从配置文件推导，在生成的 Cloudflare.Env 上补充。
export interface SecretBindings {
  SESSION_HMAC_SECRET?: string;
  ADMIN_INITIAL_PASSWORD?: string;
  AGENT_TOKEN_PEPPER?: string;
  NOTIFICATION_KEK?: string;
  NOTIFICATION_KEK_PREVIOUS?: string;

}

// 允许预览/测试覆盖的可选运行参数；wrangler.toml 中的正式 Vars 由 worker-env.d.ts 生成。
export interface OptionalRuntimeBindings {
  NOTIFICATION_KEK_PREVIOUS_VERSION?: string;
  ALLOWED_ORIGINS?: string;
  LOG_REQUESTS?: string;
  NODE_ENV?: string;
}

export type Bindings = Cloudflare.Env &
  SecretBindings &
  OptionalRuntimeBindings;

export type DurableObjectNamespaceLike =
  Cloudflare.Env["AGENT_ROOM"];
