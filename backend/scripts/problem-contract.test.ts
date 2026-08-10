import assert from "node:assert/strict";
import { Hono } from "hono";
import { problemResponse } from "../src/platform/http/problem";

const app = new Hono();
app.get("/problem", (c) =>
  problemResponse(c, {
    status: 409,
    code: "RESOURCE_CONFLICT",
    title: "Resource conflict",
    detail: "fixture detail",
  })
);

const response = await app.request("https://example.test/problem", {
  headers: { "X-Request-ID": "fixture-trace" },
});
assert.equal(response.status, 409);
assert.match(response.headers.get("Content-Type") ?? "", /^application\/problem\+json/);
assert.deepEqual(await response.json(), {
  type: "https://xugou.dev/problems/resource-conflict",
  title: "Resource conflict",
  status: 409,
  code: "RESOURCE_CONFLICT",
  trace_id: "fixture-trace",
  detail: "fixture detail",
});
