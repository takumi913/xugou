import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../providers/AuthProvider";
import PageLoading from "./PageLoading";

interface ProtectedRouteProps {
  children: React.ReactNode;
}

/**
 * 路由守卫组件
 * 用于保护需要登录才能访问的路由
 */
export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  // 如果正在加载，显示加载状态
  if (isLoading) {
    return <PageLoading />;
  }

  // 如果未登录，重定向到登录页面，并保存当前路径
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // 已登录，渲染子组件
  return <>{children}</>;
}
