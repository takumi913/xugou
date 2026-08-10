import type { components } from "../api/generated/v2-schema";

type GeneratedAgent = components["schemas"]["Agent"];
type GeneratedAgentUpdate = components["schemas"]["AgentUpdate"];

export type MetricHistory = components["schemas"]["AgentMetric"];
type GeneratedPublicMetricHistory = components["schemas"]["PublicAgentMetric"];
export type PublicMetricHistory = Omit<GeneratedPublicMetricHistory, "id"> & {
  id?: number;
};
export type DisplayMetricHistory = MetricHistory | PublicMetricHistory;
export type AgentWithLatestMetrics = Omit<
  components["schemas"]["PublicAgent"],
  "metrics"
> & { metrics: PublicMetricHistory | null };
export type TrafficCalcType = NonNullable<
  GeneratedAgentUpdate["traffic_calc_type"]
>;
export type BillingCycle = NonNullable<
  GeneratedAgentUpdate["billing_cycle"]
>;

/**
 * AgentCard consumes a compatibility view assembled from generated management,
 * dashboard, or public DTOs. Contract fields remain generated; only old display
 * encodings (comma/JSON strings and 0/1 flags) are adapted here.
 */
export type Agent = Pick<
  GeneratedAgent,
  "id" | "name" | "created_at" | "updated_at"
> &
  Partial<
    Omit<
      GeneratedAgent,
      | "status"
      | "ip_addresses"
      | "tags"
      | "auto_renewal"
      | "is_hidden"
      | "auto_update"
      | "billing_cycle"
      | "traffic_calc_type"
      | "traffic_reset_day"
      | "metrics"
    >
  > & {
    status: "active" | "inactive" | "connecting" | "unknown";
    ip_addresses?: string | null;
    last_state_changed_at?: string | null;
    collect_interval?: number | null;
    report_interval?: number | null;
    tags?: string | null;
    auto_renewal?: number | null;
    is_hidden?: number | null;
    auto_update?: number | null;
    billing_cycle?: BillingCycle | null;
    traffic_calc_type?: TrafficCalcType | null;
    traffic_reset_day?: number | null;
    metrics?: MetricHistory[];
  };

// ping_json is intentionally an opaque JSON string in the transport contract.
export interface PingResult {
  target?: string;
  latency_ms?: number;
  loss?: boolean;
}

export type MetricType = "cpu" | "memory" | "disk" | "network" | "load";
