import { Hono } from "hono";
import type { Bindings } from "../../../models/db";
import type { AuthVariables } from "../../../types";
import { createDashboardUseCases } from "../composition";

const dashboard = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();

dashboard.get("/", async (c) => {
  const projection = await createDashboardUseCases(c.env).getDashboard();
  return c.json(projection, 200);
});

export { dashboard };
