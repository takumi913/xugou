# XUGOU 项目开发规则

## 项目概述

XUGOU 是一个基于 CloudFlare 的轻量化系统监控平台，采用现代化的全栈架构：
- **Frontend**: React + TypeScript + Vite + TailwindCSS + Radix UI
- **Backend**: Hono + TypeScript + CloudFlare Workers + D1 Database
- **Agent**: Go + Cobra CLI + gopsutil
- **部署**: CloudFlare Workers + D1

## 代码规范

### 通用规范

1. **代码是写给人看的，只是机器恰好可以运行而已！**
2. **每次修改代码以后，需要确保代码能够编译通过！**
3. 使用 TypeScript 进行类型安全开发
4. 遵循 ESLint 和 Prettier 配置
5. 使用有意义的变量和函数命名
6. 添加必要的注释，特别是复杂业务逻辑
7. 保持代码简洁，避免过度工程化

### Frontend 规范

#### 文件组织
```
src/
├── api/           # API 调用封装（generated/ 下是 openapi-typescript 产出，勿手改）
├── assets/        # 预生成的静态数据（如 worldMap.ts）
├── components/    # 可复用组件
│   └── ui/       # 基础 UI 组件 (shadcn/ui)
├── config/        # 配置文件
├── features/      # 按业务域组织的复合组件
├── hooks/         # 自定义 React Hooks
├── i18n/          # 国际化配置
├── lib/           # 工具库
├── pages/         # 页面组件
├── providers/     # Context Providers
├── router/        # 路由配置
├── styles/        # 样式文件
├── themes/        # 状态页主题注册表（见 themes/README.md）
├── types/         # TypeScript 类型定义
└── utils/         # 工具函数
```

#### 组件规范
1. 使用函数式组件和 React Hooks
2. 组件文件使用 PascalCase 命名 (如 `MonitorCard.tsx`)
3. 导出组件使用 default export
4. Props 接口命名为 `ComponentNameProps`
5. 使用 Radix UI 作为基础组件库
6. 样式使用 TailwindCSS，避免内联样式
7. 状态管理优先使用 React Context，复杂状态考虑 Zustand

#### 示例组件结构
```typescript
interface MonitorCardProps {
  monitor: Monitor;
  onEdit?: (monitor: Monitor) => void;
}

export default function MonitorCard({ monitor, onEdit }: MonitorCardProps) {
  // 组件逻辑
  return (
    <Card className="p-4">
      {/* 组件内容 */}
    </Card>
  );
}
```

### Backend 规范

#### 文件组织
```
src/
├── api/           # 未模块化的少数路由（session / profile / dashboard / ws）
├── config/        # drizzle 客户端工厂
├── contracts/     # 跨层共享的协议类型（problem / queue）
├── db/
│   └── schema.ts  # Drizzle 模式定义，仅用于生成 drizzle/ 下的迁移
├── durable/       # Durable Object（AgentRoom，实时推送）
├── jobs/          # cron 任务与保留策略
├── middlewares/   # 中间件
├── models/        # 跨模块共享的数据类型
├── modules/       # 业务模块，见下方分层
├── platform/      # 基础设施（observability / queues / security）
├── shared/        # 通用工具（errors / pagination）
├── test-utils/    # 单测用的 D1 适配层
└── utils/         # 工具函数
```

每个 `modules/<域>/` 内部统一分层：

```
domain/         # 领域模型与纯函数
application/    # 用例（UseCases），编排领域逻辑
persistence/    # D1 访问；D1Legacy*Facade 负责把新模型转成 v1 响应形状
http/           # Hono 路由与 zod schema
queue/          # outbox 消费者
composition.ts  # 依赖装配，路由只通过它拿用例
```

#### API 规范
1. 使用 Hono 框架构建 RESTful API
2. 路由按业务域挂在 `modules/<域>/http/`，在 `worker.ts` 统一 route
3. 业务接口统一使用 `/api/v2/` 前缀（`/api/ws` 是 WebSocket 升级入口）
4. 错误响应走 `shared/errors/ApplicationProblem`，不要手拼 JSON
5. 使用中间件处理 CORS、会话认证等

#### 数据库规范
1. 使用 SQLite (CloudFlare D1) 作为数据库
2. **数据访问以 `env.DB.prepare()` 原生 SQL 为主**；Drizzle 只用于两处
   （`DrizzleAgentRepository`、`OutboxRelay`）和生成迁移，不要为了统一
   把现有原生 SQL 改写成 Drizzle
3. 所有表结构定义在 `db/schema.ts`，改完跑 `pnpm run generate` 生成迁移，
   迁移文件只增不改——D1 按 `migrations` 表记录已应用的版本
4. 表名使用复数形式，字段使用 snake_case
5. 时间字段新表一律用 `*_at_ms`（epoch 毫秒整数），旧表的 ISO 文本字段保持不动
6. 加表之前先确认没有现成的表能承载；删表要同时清理 `schema.ts` 与读写它的代码

#### 示例 API 结构
```typescript
const monitors = new Hono<{ Bindings: Bindings }>();

monitors.get("/", async (c) => {
  const page = await createMonitorUseCases(c.env).list({ limit: 100 });
  return c.json({ success: true, data: page.data });
});
```

### Agent 规范

#### 文件组织
```
cmd/
└── agent/         # CLI 命令定义
pkg/
├── collector/     # 数据收集器
├── config/        # 配置管理
├── model/         # 数据模型
├── reporter/      # 数据上报
└── utils/         # 工具函数
```

#### Go 代码规范
1. 遵循 Go 官方代码规范
2. 使用 Cobra 构建 CLI 应用
3. 使用 Viper 进行配置管理
4. 错误处理要完整，不忽略任何错误
5. 包名使用小写，避免下划线
6. 导出的函数和类型使用 PascalCase
7. 私有函数和变量使用 camelCase
