export interface StatusPageConfigCommand {
  title: string;
  description: string;
  logoUrl: string;
  customCss: string;
  theme: string;
  monitors: number[];
  agents: number[];
}

export interface ActiveStatusPublication {
  payloadJson: string;
  etag: string;
  generatedAt: string;
}

export interface ActiveMetricPublication extends ActiveStatusPublication {
  agentId: number;
}

export interface PublicMetricPublicationDraft {
  agentId: number;
  metrics: import("./public-contract").PublicAgentMetric[];
}
