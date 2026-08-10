import { ApplicationProblem } from "../../../shared/errors/ApplicationProblem";
import type {
  ActiveStatusPublication,
  ActiveMetricPublication,
  StatusPageConfigCommand,
} from "../domain/models";

export interface StatusRepositoryPort {
  getConfig(): Promise<unknown>;
  saveConfig(input: StatusPageConfigCommand): Promise<unknown>;
  getActivePublication(): Promise<ActiveStatusPublication | null>;
  getActiveMetricPublication(agentId: number): Promise<ActiveMetricPublication | null>;
}

export class StatusUseCases {
  constructor(private readonly repository: StatusRepositoryPort) {}

  getConfig() {
    return this.repository.getConfig();
  }

  async saveConfig(input: StatusPageConfigCommand) {
    if (
      input.monitors.length > 100 ||
      input.agents.length > 100 ||
      new Set(input.monitors).size !== input.monitors.length ||
      new Set(input.agents).size !== input.agents.length
    ) {
      throw new ApplicationProblem(
        400,
        "STATUS_CONFIG_RESOURCE_LIMIT_INVALID",
        "Status configuration resource IDs must be unique and at most 100 per type"
      );
    }
    try {
      await this.repository.saveConfig(input);
      return await this.repository.getConfig();
    } catch (error) {
      if (error instanceof ApplicationProblem) throw error;
      if (error instanceof Error && error.name === "StatusPageConfigValidationError") {
        throw new ApplicationProblem(400, "STATUS_CONFIG_INVALID", error.message);
      }
      throw error;
    }
  }

  async getPublicData() {
    const publication = await this.repository.getActivePublication();
    if (publication) return publication;
    throw new ApplicationProblem(
      503,
      "PUBLICATION_NOT_READY",
      "Public status publication is not ready"
    );
  }

  async getPublicAgentMetrics(agentId: number) {
    const publication = await this.repository.getActiveMetricPublication(agentId);
    if (publication) return publication;
    throw new ApplicationProblem(
      404,
      "PUBLIC_AGENT_NOT_FOUND",
      "Public agent metric publication not found"
    );
  }
}
