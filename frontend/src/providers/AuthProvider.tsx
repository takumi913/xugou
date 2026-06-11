import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  ReactNode,
} from "react";
import {
  login as apiLogin,
  register as apiRegister,
  getCurrentUser,
} from "../api/auth";
import { getAllowNewUserRegistration } from "../api/settings"; // 新增
import { User, LoginRequest, RegisterRequest, AuthContextType } from "../types";
import { useTranslation } from "react-i18next";

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { t } = useTranslation();

  const clearAuthState = useCallback(() => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    setToken(null);
    setUser(null);
  }, []);

  // 验证 token 是否有效
  const verifyToken = useCallback(async () => {
    try {
      const response = await getCurrentUser();
      if (response.success && response.user) {
        setUser(response.user);
        localStorage.setItem("user", JSON.stringify(response.user));
      } else {
        // Token 无效，清除登录状态
        clearAuthState();
      }
    } catch (error) {
      console.error(t("auth.error.fetchUser"), error);
      // Token 验证失败，清除登录状态
      clearAuthState();
    } finally {
      setIsLoading(false);
    }
  }, [clearAuthState, t]);

  useEffect(() => {
    // 从 localStorage 获取 token 和 user
    const storedToken = localStorage.getItem("token");
    const storedUser = localStorage.getItem("user");

    if (storedToken && storedUser) {
      setToken(storedToken);
      setUser(JSON.parse(storedUser));
      // 验证 token 是否有效
      verifyToken();
    } else {
      setIsLoading(false);
    }
  }, [verifyToken]);

  const fetchCurrentUser = useCallback(async () => {
    try {
      const response = await getCurrentUser();
      if (response.success && response.user) {
        setUser(response.user);
        localStorage.setItem("user", JSON.stringify(response.user));
      } else {
        // 如果获取用户信息失败，清除 token 和 user
        clearAuthState();
      }
    } catch (error) {
      console.error(t("auth.error.fetchUser"), error);
      clearAuthState();
    }
  }, [clearAuthState, t]);

  useEffect(() => {
    // 如果有 token，但没有 user，则获取用户信息
    if (token && !user) {
      fetchCurrentUser();
    }
  }, [token, user, fetchCurrentUser]);

  const login = async (data: LoginRequest) => {
    try {
      const response = await apiLogin(data);
      if (response.success && response.token && response.user) {
        localStorage.setItem("token", response.token);
        localStorage.setItem("user", JSON.stringify(response.user));
        setToken(response.token);
        setUser(response.user);
      }
      return { success: response.success, message: response.message };
    } catch (error) {
      console.error(t("auth.error.login"), error);
      return { success: false, message: t("login.error.tryAgain") };
    }
  };

  const register = async (data: RegisterRequest) => {
    try {
      // 客户端再次检查是否允许注册
      const allowResponse = await getAllowNewUserRegistration();
      if (!allowResponse.success || !allowResponse.allow) {
        return { success: false, message: t("register.disabled") };
      }
      const response = await apiRegister(data);
      return { success: response.success, message: response.message };
    } catch (error) {
      console.error(t("auth.error.register"), error);
      return { success: false, message: t("register.error.tryAgain") };
    }
  };

  const logout = () => {
    clearAuthState();
    window.location.href = "/login";
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isAuthenticated: !!token,
        isLoading,
        login,
        register,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
