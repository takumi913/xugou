declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  }
}
