import {
  createBrowserRouter,
  RouteObject,
  Outlet,
  useLocation,
  Navigate,
} from "react-router-dom";
import { lazy, Suspense, ReactNode } from "react";

// 布局
import Layout from "../components/Layout";
import ProtectedRoute from "../components/ProtectedRoute";
import PageLoading from "../components/PageLoading";

// 懒加载页面组件
const Dashboard = lazy(() => import("../pages/Dashboard"));
const Home = lazy(() => import("../pages/Home"));
const NotFound = lazy(() => import("../pages/NotFound"));

// 代理页面组件
const AgentsList = lazy(() => import("../pages/agents/AgentsList"));
const AgentDetail = lazy(() => import("../pages/agents/AgentDetail"));
const CreateAgent = lazy(() => import("../pages/agents/CreateAgent"));
const EditAgent = lazy(() => import("../pages/agents/EditAgent"));

// 状态页面组件
const StatusPage = lazy(() => import("../pages/status/StatusPage"));
const StatusPageConfig = lazy(() => import("../pages/status/StatusPageConfig"));

// 监控页面组件
const MonitorsList = lazy(() => import("../pages/monitors/MonitorsList"));
const MonitorDetail = lazy(() => import("../pages/monitors/MonitorDetail"));
const CreateMonitor = lazy(() => import("../pages/monitors/CreateMonitor"));
const EditMonitor = lazy(() => import("../pages/monitors/EditMonitor"));

// 通知页面组件
const NotificationsConfig = lazy(
  () => import("../pages/notifications/NotificationsConfig")
);


// 主题列表页面组件
const ThemeList = lazy(() => import("../pages/themes/ThemeList"));

// 认证页面组件
const Login = lazy(() => import("../pages/auth/Login"));
const UserProfile = lazy(() => import("../pages/users/UserProfile"));

// 用于包装Layout并提供children
interface LayoutWrapperProps {
  children: ReactNode;
}
const LayoutWrapper: React.FC<LayoutWrapperProps> = ({ children }) => {
  // 检查当前路径是否为状态页面，如果是则不使用Layout包裹
  // 使用 useLocation 而非 window.location，软导航时也能重新计算
  const location = useLocation();
  const isStatusPage =
    location.pathname === "/status" || location.pathname === "/status/public";
  return isStatusPage ? <>{children}</> : <Layout>{children}</Layout>;
};

// 需要授权的路由
const protectedRoutes: RouteObject[] = [
  {
    path: "/dashboard",
    element: (
      <ProtectedRoute>
        <Suspense fallback={<PageLoading />}>
          <Dashboard />
        </Suspense>
      </ProtectedRoute>
    ),
  },
  // 代理页面
  {
    path: "/agents",
    children: [
      {
        path: "",
        element: (
          <ProtectedRoute>
            <Suspense fallback={<PageLoading />}>
              <AgentsList />
            </Suspense>
          </ProtectedRoute>
        ),
      },
      {
        path: ":id",
        element: (
          <ProtectedRoute>
            <Suspense fallback={<PageLoading />}>
              <AgentDetail />
            </Suspense>
          </ProtectedRoute>
        ),
      },
      {
        path: "create",
        element: (
          <ProtectedRoute>
            <Suspense fallback={<PageLoading />}>
              <CreateAgent />
            </Suspense>
          </ProtectedRoute>
        ),
      },
      {
        path: "edit/:id",
        element: (
          <ProtectedRoute>
            <Suspense fallback={<PageLoading />}>
              <EditAgent />
            </Suspense>
          </ProtectedRoute>
        ),
      },
    ],
  },
  // 状态页面配置
  {
    path: "/status/config",
    element: (
      <ProtectedRoute>
        <Suspense fallback={<PageLoading />}>
          <StatusPageConfig />
        </Suspense>
      </ProtectedRoute>
    ),
  },
  // 监控页面
  {
    path: "/monitors",
    children: [
      {
        path: "",
        element: (
          <ProtectedRoute>
            <Suspense fallback={<PageLoading />}>
              <MonitorsList />
            </Suspense>
          </ProtectedRoute>
        ),
      },
      {
        path: ":id",
        element: (
          <ProtectedRoute>
            <Suspense fallback={<PageLoading />}>
              <MonitorDetail />
            </Suspense>
          </ProtectedRoute>
        ),
      },
      {
        path: "create",
        element: (
          <ProtectedRoute>
            <Suspense fallback={<PageLoading />}>
              <CreateMonitor />
            </Suspense>
          </ProtectedRoute>
        ),
      },
      {
        path: "edit/:id",
        element: (
          <ProtectedRoute>
            <Suspense fallback={<PageLoading />}>
              <EditMonitor />
            </Suspense>
          </ProtectedRoute>
        ),
      },
    ],
  },
  // 通知页面
  {
    path: "/notifications",
    element: (
      <ProtectedRoute>
        <Suspense fallback={<PageLoading />}>
          <NotificationsConfig />
        </Suspense>
      </ProtectedRoute>
    ),
  },

  // 主题列表页面
  {
    path: "/themes",
    element: (
      <ProtectedRoute>
        <Suspense fallback={<PageLoading />}>
          <ThemeList />
        </Suspense>
      </ProtectedRoute>
    ),
  },
  // 个人资料
  {
    path: "/profile",
    element: (
      <ProtectedRoute>
        <Suspense fallback={<PageLoading />}>
          <UserProfile />
        </Suspense>
      </ProtectedRoute>
    ),
  },
];

// 公共路由
const publicRoutes: RouteObject[] = [
  {
    path: "/",
    element: (
      <Suspense fallback={<PageLoading />}>
        <Home />
      </Suspense>
    ),
  },
  {
    path: "/status",
    element: (
      <Suspense fallback={<PageLoading />}>
        <StatusPage />
      </Suspense>
    ),
  },
  {
    path: "/status/public",
    element: <Navigate to="/status" replace />,
  },
  {
    path: "/login",
    element: (
      <Suspense fallback={<PageLoading />}>
        <Login />
      </Suspense>
    ),
  },
  {
    path: "*",
    element: (
      <Suspense fallback={<PageLoading />}>
        <NotFound />
      </Suspense>
    ),
  },
];

// 创建路由
const router: ReturnType<typeof createBrowserRouter> = createBrowserRouter(
  [
    {
      element: (
        <LayoutWrapper>
          <Outlet />
        </LayoutWrapper>
      ),
      children: [...protectedRoutes, ...publicRoutes],
    },
  ],
  {
    future: {
      v7_relativeSplatPath: true,
      v7_fetcherPersist: true,
      v7_normalizeFormMethod: true,
      v7_partialHydration: true,
      v7_skipActionErrorRevalidation: true,
    },
  }
);

export default router;
