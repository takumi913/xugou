import axios from "axios";
import { ENV_API_BASE_URL, ENV_API_TIMEOUT } from "../config";

// 统一的登录态 token 读取（api client / liveSocket / AuthProvider 共用）
export function getStoredToken(): string | null {
  return localStorage.getItem("token");
}

// 创建 axios 实例
const api = axios.create({
  baseURL: ENV_API_BASE_URL || "", // 从配置中获取API基础URL
  timeout: ENV_API_TIMEOUT || 100000, // 从配置中获取超时设置
  headers: {
    "Content-Type": "application/json",
  },
  // Cloudflare Pages 访问 Cloudflare Workers 时的跨域设置
  withCredentials: false, // 不发送 cookies
});

// 请求拦截器
api.interceptors.request.use(
  (config) => {
    // 从 localStorage 获取 token
    const token = getStoredToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// 响应拦截器
api.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    if (error.response) {
      // 处理 401 未授权错误
      if (error.response.status === 401) {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        window.location.href = "/login";
      }
    }
    return Promise.reject(error);
  }
);

export default api;
