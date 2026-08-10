import type { components } from "./generated/v2-schema";
import { unwrapOpenApi, v2Client } from "./generated/v2-client";

export type QueueFailure = components["schemas"]["QueueFailure"];
export type QueueFailureStatus = QueueFailure["status"];
export type QueueFailurePage = components["schemas"]["QueueFailurePage"];
export type QueueLedgerHealth = components["schemas"]["QueueLedgerHealth"];
export type ReleaseReadiness = components["schemas"]["ReleaseReadiness"];
export type CompatibilityHit = components["schemas"]["CompatibilityHit"];
export type SecurityAuditEvent = components["schemas"]["SecurityAuditEvent"];
export type SecurityAuditPage = components["schemas"]["SecurityAuditPage"];
export type SecurityAuditOutcome = SecurityAuditEvent["outcome"];
export type CredentialCoverage = components["schemas"]["CredentialCoverage"];

export async function getQueueHealth(): Promise<QueueLedgerHealth> {
  const result = await v2Client.GET("/api/v2/operations/queue-health");
  return unwrapOpenApi(result).data;
}

export async function getReleaseReadiness(): Promise<ReleaseReadiness> {
  const result = await v2Client.GET("/api/v2/operations/release-readiness");
  return unwrapOpenApi(result).data;
}

export async function getCompatibilityHits(days = 30): Promise<CompatibilityHit[]> {
  const result = await v2Client.GET("/api/v2/operations/compatibility-hits", {
    params: { query: { days } },
  });
  return unwrapOpenApi(result).data;
}

export async function getSecurityAuditEvents(input: {
  cursor?: string;
  event_type?: string;
  outcome?: SecurityAuditOutcome;
  limit?: number;
} = {}): Promise<SecurityAuditPage> {
  const result = await v2Client.GET(
    "/api/v2/operations/security-audit",
    { params: { query: input } }
  );
  return unwrapOpenApi(result);
}

export async function getCredentialCoverage(): Promise<CredentialCoverage> {
  const result = await v2Client.GET(
    "/api/v2/operations/credential-coverage"
  );
  return unwrapOpenApi(result).data;
}

export async function getQueueFailures(input: {
  cursor?: string;
  status?: QueueFailureStatus;
  limit?: number;
} = {}): Promise<QueueFailurePage> {
  const result = await v2Client.GET("/api/v2/operations/queue-failures", {
    params: { query: input },
  });
  return unwrapOpenApi(result);
}

export async function replayQueueFailure(
  failureId: string
): Promise<{ failure_id: string; status: "replayed" }> {
  const result = await v2Client.POST(
    "/api/v2/operations/queue-failures/{id}/replay",
    { params: { path: { id: failureId } } }
  );
  return unwrapOpenApi(result).data;
}

export async function terminateQueueFailure(failureId: string): Promise<void> {
  const result = await v2Client.POST(
    "/api/v2/operations/queue-failures/{id}/terminate",
    { params: { path: { id: failureId } } }
  );
  if (!result.response.ok) {
    throw new Error(`HTTP ${result.response.status}`);
  }
}
