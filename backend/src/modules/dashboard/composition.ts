import type { Bindings } from "../../models/db";
import { DashboardUseCases } from "./application/DashboardUseCases";
import { D1DashboardQuery } from "./persistence/D1DashboardQuery";

export function createDashboardUseCases(env: Bindings) {
  return new DashboardUseCases(new D1DashboardQuery(env));
}
