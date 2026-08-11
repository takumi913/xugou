import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROL_PLANE_RATE_LIMIT_POLICY,
  LOGIN_RATE_LIMIT_POLICY,
  getRequestClientIp,
  sanitizeSecurityAuditMetadata,
} from "../src/platform/security/SecurityStore";
import {
  createCorsHeaders,
  getAllowedOrigin,
} from "../src/middlewares/cors";
import { MAX_API_REQUEST_BODY_BYTES } from "../src/middlewares/body-limit";

const sanitized = sanitizeSecurityAuditMetadata({
  action: "rotate",
  token: "xga_fixture",
  password_hash: "fixture",
  Authorization: "Bearer fixture",
  cookieValue: "fixture",
  count: 2,
  detail: "x".repeat(300),
  missing: undefined,
});

assert.deepEqual(Object.keys(sanitized).sort(), ["action", "count", "detail"]);
assert.equal(sanitized.action, "rotate");
assert.equal(sanitized.count, 2);
assert.equal(String(sanitized.detail).length, 256);

assert.deepEqual(LOGIN_RATE_LIMIT_POLICY, {
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
});
assert.equal(CONTROL_PLANE_RATE_LIMIT_POLICY.maxAttempts, 10);
assert.equal(MAX_API_REQUEST_BODY_BYTES, 2 * 1024 * 1024);

assert.equal(
  getAllowedOrigin(
    "https://status.example.test",
    "https://status.example.test/api/v2/session/me"
  ),
  "https://status.example.test"
);
assert.equal(
  getAllowedOrigin(
    "https://evil.example.test",
    "https://status.example.test/api/v2/session/me"
  ),
  null
);
assert.equal(
  getAllowedOrigin(
    "https://console.example.test",
    "https://status.example.test/api/v2/session/me",
    { ALLOWED_ORIGINS: "https://console.example.test" }
  ),
  "https://console.example.test"
);
assert.equal(
  getAllowedOrigin(
    "https://evil.example.test",
    "https://status.example.test/api/v2/session/me",
    { ALLOWED_ORIGINS: "*" }
  ),
  null,
  "credentialed CORS must never reflect a wildcard origin"
);
const rejectedCorsHeaders = createCorsHeaders(
  new Request("https://status.example.test/api/v2/session/me", {
    headers: { Origin: "https://evil.example.test" },
  })
);
assert.equal(rejectedCorsHeaders.has("Access-Control-Allow-Origin"), false);
assert.equal(rejectedCorsHeaders.has("Access-Control-Allow-Credentials"), false);

assert.equal(
  getRequestClientIp(
    new Request("https://example.test", {
      headers: { "CF-Connecting-IP": "203.0.113.10" },
    })
  ),
  "203.0.113.10"
);
assert.equal(
  getRequestClientIp(
    new Request("https://example.test", {
      headers: { "X-Forwarded-For": "198.51.100.4, 10.0.0.1" },
    })
  ),
  "198.51.100.4"
);

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(backendRoot, "..");
const gitignore = readFileSync(join(repositoryRoot, ".gitignore"), "utf8");
assert.match(
  gitignore,
  /^\/\.wrangler\.production\.toml$/m,
  "rendered production Wrangler config must stay outside version control"
);

function typescriptFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory()
      ? typescriptFiles(path)
      : /\.(?:ts|tsx)$/.test(name)
        ? [path]
        : [];
  });
}

for (const root of [join(backendRoot, "src"), join(backendRoot, "../frontend/src")]) {
  for (const file of typescriptFiles(root)) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /\b(?:as unknown as|as any|@ts-ignore|@ts-expect-error)\b/,
      `${file} must not hide type errors behind an escape hatch`
    );
  }
}

const bootstrapSource = readFileSync(
  join(backendRoot, "src/modules/auth/application/AuthUseCases.ts"),
  "utf8"
);
assert.doesNotMatch(
  bootstrapSource,
  /bcrypt\.hash\(["'][^"']+["']/,
  "admin bootstrap must not embed a default password"
);
assert.doesNotMatch(bootstrapSource, /admin123/);

for (const relativePath of ["src/middlewares/auth.ts", "src/api/ws.ts"]) {
  const source = readFileSync(join(backendRoot, relativePath), "utf8");
  assert.doesNotMatch(source, /hono\/jwt|CF_VERSION_METADATA\?\.id/);
  assert.doesNotMatch(source, /legacy-jwt/);
}
const webSocketSource = readFileSync(join(backendRoot, "src/api/ws.ts"), "utf8");
assert.doesNotMatch(webSocketSource, /query\(["']token["']\)/);
assert.doesNotMatch(webSocketSource, /Sec-WebSocket-Protocol|X-Echo-Protocol/);
assert.match(webSocketSource, /getAllowedOrigin/);

for (const relativePath of [
  "src/types.ts",
  "src/middlewares/auth.ts",
  "src/worker.ts",
]) {
  const source = readFileSync(join(backendRoot, relativePath), "utf8");
  assert.doesNotMatch(
    source,
    /JwtPayload|jwtPayload|jwtMiddleware/,
    `${relativePath} must use opaque-session terminology`
  );
}

const generatedClient = readFileSync(
  join(backendRoot, "../frontend/src/api/generated/v2-client.ts"),
  "utf8"
);
assert.doesNotMatch(generatedClient, /getItem\(["']token["']\)/);
assert.doesNotMatch(generatedClient, /Authorization.*Bearer.*token/);
