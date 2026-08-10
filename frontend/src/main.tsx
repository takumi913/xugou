import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { AuthProvider } from "./providers/AuthProvider";
import { LanguageProvider } from "./providers/LanguageProvider";
import { ThemeProvider } from "./providers/ThemeProvider";
import "./styles/global.css";
import "./i18n/config";
import router from "./router";
import QueryProvider from "./providers/QueryProvider";

// 删除了手动的 Service Worker 注册代码
// vite-plugin-pwa 会自动处理

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryProvider>
        <AuthProvider>
          <LanguageProvider>
            <RouterProvider router={router} />
          </LanguageProvider>
        </AuthProvider>
      </QueryProvider>
    </ThemeProvider>
  </StrictMode>
);
