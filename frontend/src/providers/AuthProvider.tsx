import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import {
  getCurrentUser,
  login as apiLogin,
  logout as apiLogout,
} from "../api/auth";
import { AuthContextType, LoginRequest, User } from "../types";
import { useTranslation } from "react-i18next";
import { queryClient } from "./QueryProvider";
import { OpenApiRequestError } from "../api/generated/v2-client";

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function clearLegacyAuthStorage() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
}

export const AuthProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { t } = useTranslation();

  const clearAuthState = useCallback(() => {
    clearLegacyAuthStorage();
    queryClient.clear();
    setUser(null);
  }, []);

  useEffect(() => {
    let active = true;

    const restoreSession = async () => {
      try {
        const response = await getCurrentUser();
        if (active && response.success && response.user) {
          setUser(response.user);
          // 清理早期版本留下的可读认证数据；当前会话只由 Cookie 承载。
          clearLegacyAuthStorage();
        } else if (active) {
          clearAuthState();
        }
      } catch (error) {
        if (active) {
          if (error instanceof OpenApiRequestError && error.status === 401) {
            // 匿名访问公开状态页是正常路径；保留其已启动的 React Query。
            clearLegacyAuthStorage();
            setUser(null);
          } else {
            console.error(t("auth.error.fetchUser"), error);
            clearAuthState();
          }
        }
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    };

    void restoreSession();
    return () => {
      active = false;
    };
  }, [clearAuthState, t]);

  useEffect(() => {
    const handleUnauthorized = () => {
      clearAuthState();
    };
    window.addEventListener("xugou:unauthorized", handleUnauthorized);
    return () => {
      window.removeEventListener("xugou:unauthorized", handleUnauthorized);
    };
  }, [clearAuthState]);

  const login = async (data: LoginRequest) => {
    try {
      const response = await apiLogin(data);
      if (response.success && response.user) {
        clearLegacyAuthStorage();
        setUser(response.user);
      }
      return { success: response.success, message: response.message };
    } catch (error) {
      console.error(t("auth.error.login"), error);
      return { success: false, message: t("login.error.tryAgain") };
    }
  };

  const logout = async () => {
    try {
      await apiLogout();
    } catch (error) {
      console.error(t("auth.error.logout", "退出登录失败"), error);
    } finally {
      clearAuthState();
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: Boolean(user),
        isLoading,
        login,
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
