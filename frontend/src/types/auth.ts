import type { components } from "../api/generated/v2-schema";
import { User } from "./users";

/**
 * 认证相关类型定义
 */

export type LoginRequest = components["schemas"]["LoginCommand"];

export interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (data: LoginRequest) => Promise<{ success: boolean; message: string }>;
  logout: () => Promise<void>;
}
