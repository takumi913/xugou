import assert from "node:assert/strict";
import {
  DashboardUseCases,
  type DashboardQueryPort,
} from "../src/modules/dashboard/application/DashboardUseCases";

const expected = {
  monitors: [{ id: 1, name: "api" }],
  agents: [{ id: 2, name: "edge" }],
  summary: {
    monitors_total: 1,
    monitors_up: 1,
    monitors_down: 0,
    monitors_pending: 0,
    monitors_avg_response_time_ms: 23,
    agents_total: 1,
    agents_online: 1,
    agents_offline: 0,
    total_traffic_bytes: 30,
    network_rx_speed_bps: 4,
    network_tx_speed_bps: 5,
  },
  monitors_has_more: false,
  agents_has_more: false,
};
const query: DashboardQueryPort = {
  async getDashboard() {
    return expected;
  },
};

assert.deepEqual(await new DashboardUseCases(query).getDashboard(), expected);
