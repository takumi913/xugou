import { Hono } from "hono";
import type { Bindings } from "../../../models/db";
import type { AuthVariables } from "../../../types";
import {
  adminPasswordChangeSchema,
  adminProfileUpdateSchema,
  legacyBadRequest,
} from "./schemas";
import {
  changeAdminPassword,
  updateAdminProfile,
} from "../persistence/D1ProfileStore";
import { revokeOtherSessionsAfterPasswordChange } from "../persistence/D1SessionStore";
import { writeSecurityAuditEvent } from "../../../platform/security/SecurityStore";
import {
  isV2ApiRequest,
  problemResponse,
} from "../../../platform/http/problem";

const profile = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();

function profileFailure(
  c: Parameters<typeof problemResponse>[0],
  result: { status: number; message?: string },
  operation: "profile" | "password"
) {
  const code =
    result.status === 404
      ? "ADMIN_NOT_FOUND"
      : result.status === 400
        ? operation === "password"
          ? "CURRENT_PASSWORD_INVALID"
          : "PROFILE_CONFLICT"
        : operation === "password"
          ? "PASSWORD_UPDATE_FAILED"
          : "PROFILE_UPDATE_FAILED";
  return problemResponse(c, {
    status: result.status,
    code,
    title:
      result.status === 404
        ? "Administrator not found"
        : operation === "password"
          ? "Password update failed"
          : "Profile update failed",
    detail: result.message,
  });
}

profile.put("/", async (c) => {
  const admin = c.get("admin");
  const parsed = adminProfileUpdateSchema.safeParse(
    await c.req.json().catch(() => null)
  );
  if (!parsed.success) {
    if (isV2ApiRequest(c)) {
      return problemResponse(c, {
        status: 400,
        code: "VALIDATION_ERROR",
        title: "Request validation failed",
      });
    }
    return c.json(legacyBadRequest("资料更新参数无效"), 400);
  }

  const result = await updateAdminProfile(c.env, admin.id, parsed.data);
  await writeSecurityAuditEvent(c.env, {
    eventType: "admin.profile.update",
    outcome: result.success ? "success" : "failure",
    actorType: "admin",
    actorId: admin.id,
    subjectType: "admin",
    subjectId: admin.id,
    request: c.req.raw,
    metadata: { changed_username: parsed.data.username !== undefined },
  });
  if (!result.success && isV2ApiRequest(c)) {
    return profileFailure(c, result, "profile");
  }
  return c.json(
    { success: result.success, user: result.user, message: result.message },
    result.status as 200 | 400 | 404 | 500
  );
});

profile.post("/change-password", async (c) => {
  const admin = c.get("admin");
  const parsed = adminPasswordChangeSchema.safeParse(
    await c.req.json().catch(() => null)
  );
  if (!parsed.success) {
    if (isV2ApiRequest(c)) {
      return problemResponse(c, {
        status: 400,
        code: "VALIDATION_ERROR",
        title: "Request validation failed",
      });
    }
    return c.json(legacyBadRequest("密码参数无效"), 400);
  }

  const result = await changeAdminPassword(c.env, admin.id, {
    currentPassword: parsed.data.currentPassword,
    newPassword: parsed.data.newPassword,
  });
  if (result.success) {
    await revokeOtherSessionsAfterPasswordChange(
      c.env,
      admin.id,
      c.get("authSessionToken") ?? null
    );
  }
  await writeSecurityAuditEvent(c.env, {
    eventType: "admin.password.change",
    outcome: result.success ? "success" : "failure",
    actorType: "admin",
    actorId: admin.id,
    subjectType: "admin",
    subjectId: admin.id,
    request: c.req.raw,
  });
  if (!result.success && isV2ApiRequest(c)) {
    return profileFailure(c, result, "password");
  }
  return c.json(
    { success: result.success, message: result.message },
    result.status as 200 | 400 | 404 | 500
  );
});

export { profile };
