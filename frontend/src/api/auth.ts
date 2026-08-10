import type { components } from "./generated/v2-schema";
import type { LoginRequest } from "../types/auth";
import {
  unwrapOpenApi,
  v2Client,
} from "./generated/v2-client";

export type AuthResponse = components["schemas"]["SessionResult"];

// 登录
export const login = async (
  credentials: LoginRequest
): Promise<AuthResponse> => {
  return unwrapOpenApi(
    await v2Client.POST("/api/v2/session/login", { body: credentials })
  );
};

// 获取当前用户信息
export const getCurrentUser = async (): Promise<AuthResponse> => {
  return unwrapOpenApi(await v2Client.GET("/api/v2/session/me"));
};

// 退出登录
export const logout = async (): Promise<AuthResponse> => {
  return unwrapOpenApi(await v2Client.POST("/api/v2/session/logout"));
};
