import type { components } from "./generated/v2-schema";
import { unwrapOpenApi, v2Client } from "./generated/v2-client";

export type UpdateProfileRequest = components["schemas"]["AdminProfileUpdate"];
export type ChangePasswordRequest = components["schemas"]["AdminPasswordChange"];

export const updateProfile = async (data: UpdateProfileRequest) => {
  return unwrapOpenApi(
    await v2Client.PUT("/api/v2/profile", { body: data })
  );
};

export const changePassword = async (data: ChangePasswordRequest) => {
  return unwrapOpenApi(
    await v2Client.POST("/api/v2/profile/change-password", { body: data })
  );
};
