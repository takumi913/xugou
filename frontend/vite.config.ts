import { readFileSync } from "fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from 'vite-plugin-pwa'; // 导入 PWA 插件

// 读取 package.json version，构建时注入 __APP_VERSION__（Footer 版本号显示）
const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, "package.json"), "utf-8")
) as { version?: string };

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version ?? "0.0.0"),
  },
  plugins: [
    react(),
    tailwindcss(),
    // 添加 PWA 插件配置
    VitePWA({
      registerType: 'autoUpdate', // 自动更新 Service Worker
      injectRegister: 'auto', // 自动注入注册 Service Worker 的代码
      workbox: {
        // 配置需要缓存的文件类型
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}']
      },
      // 包含在 public 目录中的其他需要缓存的资源
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      // PWA 应用清单配置
      manifest: {
        name: 'XUGOU',
        short_name: 'XUGOU',
        description: 'XUGOU 是一个基于 CloudFlare 的轻量化系统监控平台，提供系统监控和状态页面功能。',
        theme_color: '#0c0c0c',
        background_color: '#0c0c0c',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: 'android-chrome-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'android-chrome-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'android-chrome-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable' // 添加 'maskable' 图标, 优化 Android 上的显示效果
          }
        ]
      }
    })
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"), // __dirname 指向 vite.config.ts 文件所在的目录
    },
  },
  build: {
    rollupOptions: {
      external: [],
      output: {
        manualChunks: {
          // 将 lucide-react 图标单独打包
          'lucide-icons': ['lucide-react'],
          // 将主要的 React 相关库打包
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          // 将 UI 组件库打包
          'ui-vendor': ['@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu', '@radix-ui/react-select'],
        },
      },
      // 限制并发处理的文件数量
      maxParallelFileOps: 3,
    },
    commonjsOptions: {
      include: [/node_modules/],
    },
    // 增加文件监听限制
    chunkSizeWarningLimit: 1000,
    // 使用 esbuild 进行压缩（更快）
    minify: 'esbuild',
    // 减少构建时的内存使用
    target: 'esnext',
    sourcemap: false,
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        ws: true, // 支持 WebSocket 代理（/api/ws 实时链路）
        // 如果后端 API 不包含 /api 前缀，可以重写路径
        // rewrite: (path) => path.replace(/^\/api/, '')
      },
      // 如果需要代理其他路径，可以添加更多配置
    },
    // 如果需要指定前端开发服务器端口
    port: 5173,
  },
});
