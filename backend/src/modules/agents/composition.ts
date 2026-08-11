import { createDb } from "../../config/db";
import type { Bindings } from "../../models/db";
import { ApplicationProblem } from "../../shared/errors/ApplicationProblem";
import { hmacSha256Hex, sha256Hex } from "../../utils/crypto";
import { shouldTriggerAgentUpdate } from "../../utils/agentConfig";
import { AgentUseCases } from "./application/AgentUseCases";
import { D1AgentReportIngestor } from "./persistence/D1AgentReportIngestor";
import { DrizzleAgentRepository } from "./persistence/DrizzleAgentRepository";

const MIN_AGENT_TOKEN_PEPPER_LENGTH = 32;

export function createAgentUseCases(env: Bindings) {
  const repository = new DrizzleAgentRepository(env, createDb(env));
  return new AgentUseCases(
    repository,
    {
      async digest(token) {
        const pepper = env.AGENT_TOKEN_PEPPER?.trim();
        if (!pepper || pepper.length < MIN_AGENT_TOKEN_PEPPER_LENGTH) {
          throw new ApplicationProblem(
            503,
            "AGENT_CREDENTIALS_UNAVAILABLE",
            "Agent credential service is unavailable"
          );
        }
        return hmacSha256Hex(pepper, token);
      },
    },
    {
      digest(report) {
        return sha256Hex(JSON.stringify(report));
      },
    },
    new D1AgentReportIngestor(env),
    {
      shouldUpdate({ autoUpdate, currentVersion }) {
        return shouldTriggerAgentUpdate(
          autoUpdate,
          env.LATEST_AGENT_VERSION,
          currentVersion
        );
      },
    }
  );
}
