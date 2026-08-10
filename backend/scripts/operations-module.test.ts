import assert from "node:assert/strict";
import {
  decodeSecurityAuditCursor,
  encodeSecurityAuditCursor,
} from "../src/platform/security/SecurityStore";

const auditCursor = encodeSecurityAuditCursor({
  createdAt: "2026-08-09T00:00:00.000Z",
  id: "018f47f2-60e5-7b47-a8ca-58c57e1be5d4",
});
assert.deepEqual(decodeSecurityAuditCursor(auditCursor), {
  createdAt: "2026-08-09T00:00:00.000Z",
  id: "018f47f2-60e5-7b47-a8ca-58c57e1be5d4",
});
assert.equal(decodeSecurityAuditCursor("invalid"), null);
