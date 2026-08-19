import { ApplicationProblem } from "../../../shared/errors/ApplicationProblem";
import type {
  AgentMutation,
  AgentReportCommand,
  AgentView,
  AuthenticatedAgent,
} from "../domain/models";
import {
  decodeOrderedCursor,
  encodeOrderedCursor,
  type OrderedCursor,
} from "../../../shared/pagination/OrderedCursor";
import type { AgentReportSourceLocation } from "../../../utils/geo";
import { AgentBlockRejected } from "../persistence/D1AgentReportIngestor";

export interface AgentRepositoryPort {
  listPage(input: { after?: OrderedCursor; limit: number }): Promise<AgentView[]>;
  findById(id: number): Promise<AgentView | null>;
  update(id: number, input: AgentMutation): Promise<AgentView | null>;
  softDelete(id: number): Promise<boolean>;
  authenticateCredential(input: {
    token: string;
    digest: string;
    now: string;
  }): Promise<AuthenticatedAgent | null>;
}

export interface AgentCredentialDigestPort {
  digest(token: string): Promise<string>;
}

export interface ReportDigestPort {
  digest(report: AgentReportCommand): Promise<string>;
}

export interface AgentReportIngestorPort {
  process(
    agentId: number,
    report: AgentReportCommand,
    input: {
      payloadDigest: string;
      receivedAt: string;
      sourceLocation?: AgentReportSourceLocation;
    }
  ): Promise<{ outcome: "completed" | "duplicate" | "conflict" }>;
}

export interface AgentUpdatePolicyPort {
  shouldUpdate(input: {
    autoUpdate: boolean;
    currentVersion?: string;
  }): boolean;
}

export class AgentUseCases {
  constructor(
    private readonly repository: AgentRepositoryPort,
    private readonly credentialDigest: AgentCredentialDigestPort,
    private readonly reportDigest: ReportDigestPort,
    private readonly reportIngestor: AgentReportIngestorPort,
    private readonly updatePolicy: AgentUpdatePolicyPort
  ) {}

  async list(input: { cursor?: string; limit: number }) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new ApplicationProblem(400, "AGENT_LIMIT_INVALID", "Invalid agent page limit");
    }
    const after = input.cursor
      ? decodeOrderedCursor(input.cursor) ?? undefined
      : undefined;
    if (input.cursor && !after) {
      throw new ApplicationProblem(400, "AGENT_CURSOR_INVALID", "Invalid agent cursor");
    }
    const rows = await this.repository.listPage({
      after,
      limit: input.limit + 1,
    });
    const hasMore = rows.length > input.limit;
    const data = hasMore ? rows.slice(0, input.limit) : rows;
    return {
      data,
      next_cursor: hasMore
        ? (() => {
            const last = data.at(-1);
            return last
              ? encodeOrderedCursor({ sortOrder: last.sort_order, id: last.id })
              : null;
          })()
        : null,
      has_more: hasMore,
    };
  }

  async get(id: number) {
    const agent = await this.repository.findById(id);
    if (!agent) {
      throw new ApplicationProblem(404, "AGENT_NOT_FOUND", "Agent not found");
    }
    return agent;
  }

  async update(id: number, input: AgentMutation) {
    const current = await this.get(id);
    const collectInterval =
      input.collect_interval_seconds ?? current.collect_interval_seconds;
    const reportInterval =
      input.report_interval_seconds ?? current.report_interval_seconds;
    if (reportInterval < collectInterval) {
      throw new ApplicationProblem(
        400,
        "AGENT_INTERVAL_INVALID",
        "Report interval must be greater than or equal to collect interval"
      );
    }
    const updated = await this.repository.update(id, input);
    if (!updated) {
      throw new ApplicationProblem(
        409,
        "AGENT_UPDATE_CONFLICT",
        "Agent update conflict"
      );
    }
    return updated;
  }

  async delete(id: number) {
    await this.get(id);
    if (!(await this.repository.softDelete(id))) {
      throw new ApplicationProblem(
        409,
        "AGENT_DELETE_CONFLICT",
        "Agent delete conflict"
      );
    }
  }

  async acceptReport(
    token: string,
    report: AgentReportCommand,
    sourceLocation?: AgentReportSourceLocation
  ) {
    const receivedAt = new Date().toISOString();
    const agent = await this.repository.authenticateCredential({
      token,
      digest: await this.credentialDigest.digest(token),
      now: receivedAt,
    });
    if (!agent) {
      throw new ApplicationProblem(
        401,
        "AGENT_CREDENTIAL_INVALID",
        "Agent credential is invalid"
      );
    }

    let ingested: { outcome: "completed" | "duplicate" | "conflict" };
    try {
      ingested = await this.reportIngestor.process(agent.id, report, {
        payloadDigest: await this.reportDigest.digest(report),
        receivedAt,
        sourceLocation,
      });
    } catch (error) {
      // 块自身不合规是客户端的问题，返回 422 让探针不要无限重试同一批坏数据；
      // 其余异常（DB 故障等）仍是 5xx，探针会带着同一个 report_id 重发。
      if (error instanceof AgentBlockRejected) {
        throw new ApplicationProblem(422, "AGENT_BLOCK_INVALID", error.message);
      }
      throw new ApplicationProblem(
        500,
        "REPORT_PROCESSING_FAILED",
        "Failed to process agent report: " + (error instanceof Error ? error.message : String(error))
      );
    }
    if (ingested.outcome === "conflict") {
      throw new ApplicationProblem(
        409,
        "REPORT_ID_REUSED",
        "Report id was already used with different content"
      );
    }

    return {
      report_id: report.report_id,
      accepted: true,
      duplicate: ingested.outcome === "duplicate",
      config: {
        collect_interval_seconds: agent.collect_interval_seconds,
        report_interval_seconds: agent.report_interval_seconds,
        update: this.updatePolicy.shouldUpdate({
          autoUpdate: agent.auto_update,
          currentVersion: report.agent_version,
        }),
      },
    };
  }
}
