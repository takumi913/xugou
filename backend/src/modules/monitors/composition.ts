import type { Bindings } from "../../models/db";
import { getEnvNumber } from "../../utils/env";
import { MonitorUseCases } from "./application/MonitorUseCases";
import { D1MonitorRepository } from "./persistence/D1MonitorRepository";

export function createMonitorUseCases(env: Bindings) {
  return new MonitorUseCases(
    new D1MonitorRepository(env),
    getEnvNumber(env, "MIN_MONITOR_INTERVAL_SECONDS", 300, {
      min: 1,
      max: 86400,
    })
  );
}
