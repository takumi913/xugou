import api from "./client";
import { LoginRequest, RegisterRequest, AuthResponse } from "../types/auth";

// 登录
export const login = async (
  credentials: LoginRequest
): Promise<AuthResponse> => {
  const response = await api.post("/api/auth/login", credentials);
  return response.data;
};

// 注册
export const register = async (data: RegisterRequest): Promise<AuthResponse> => {
  const response = await api.post("/api/auth/register", data);
  return response.data;
};

// 获取当前用户信息
export const getCurrentUser = async (): Promise<AuthResponse> => {
  const response = await api.get("/api/auth/me");
  return response.data;
};

// 退出登录
export const logout = (): void => {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  window.location.href = "/login";
};
