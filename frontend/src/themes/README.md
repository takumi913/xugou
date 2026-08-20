# XUGOU 主题系统规范

主题是**可插拔**的：本目录下每个文件夹就是一个主题，构建时由
`themes/index.ts` 通过 `import.meta.glob` 自动发现并注册——新增主题
**不需要修改任何现有代码**。仓库内置两套标准主题作为参考实现：

| 主题 | 说明 |
|---|---|
| [`mono/`](./mono) | 黑灰简约（**默认主题**，不可删除）：中性灰阶 + 红色告警 |
| [`terminal/`](./terminal) | 绿色终端风：经典 CRT 配色 + 彩色语义色 |

## 主题的构成

```
frontend/src/themes/<id>/
├── theme.css   # 全部语义 CSS 变量（深/浅两个块）
└── index.ts    # 默认导出 ThemeManifest（元信息 + 图表配色）
```

- **`<id>`（文件夹名）就是主题 id**：kebab-case，匹配
  `/^[a-z0-9][a-z0-9-]{0,31}$/`，且必须与 `index.ts` 里 `manifest.id` 一致，
  否则注册表会拒绝加载（控制台有原因提示）。
- 主题只定义**设计令牌（颜色）**，不改布局。全站组件都消费语义变量，
  换主题即换肤。

## theme.css 规范

必须提供**两个选择器块**，且两个块覆盖**完全相同的变量集合**
（浅色块缺少某个变量时，浅色模式会漏出深色值）：

```css
:root[data-theme="<id>"]        { /* 深色模式（默认） */ }
:root[data-theme="<id>"].light  { /* 浅色模式 */ }
```

> 深浅切换（dark / light / auto 跟随系统）由框架处理，与主题正交：
> 任何主题都自动获得三档明暗能力，因此**两套变量都必须认真设计**。

### 必需变量清单

| 变量 | 语义 |
|---|---|
| `--bg-primary` | 页面底色 |
| `--bg-secondary` | 次级底色（地图国家填充等） |
| `--bg-card` | 卡片底色（半透明，建议 rgba） |
| `--bg-hover` | 悬停底色 |
| `--border-color` / `--border-active` | 常规 / 激活边框 |
| `--text-primary` / `--text-secondary` / `--text-muted` | 三级文字 |
| `--accent-green` | **主强调 / 正常态**（标题、在线状态、live 指示、低用量） |
| `--accent-blue` | 次强调（上行网速、用量 50–80%） |
| `--accent-yellow` | 用量 80–95% 警示前级 |
| `--accent-red` | **告警**（离线 / 故障 / 用量 ≥95%）——见下方红线规则 |
| `--accent-purple` / `--accent-pink` / `--accent-cyan` | 图表与装饰性次级色 |
| `--input-bg` / `--input-border` | 表单输入 |
| `--card` `--popover` `--primary-foreground` `--secondary` `--muted` `--accent` `--sidebar` `--sidebar-primary-foreground` `--sidebar-accent` | shadcn 组件库映射（实色，不要用 rgba） |

### 可选变量

| 变量 | 语义 | 缺省值 |
|---|---|---|
| `--terminal-dot-1/2/3` | 终端窗口三圆点（从左到右） | 全局灰阶 |

### 红线规则（所有主题必须遵守）

1. **`--accent-green` 与 `--accent-red` 必须肉眼可区分**——它们承载
   在线/离线、正常/故障的核心语义，色弱可辨（明度差 ≥ 2 级）最佳。
2. 文字变量与对应背景的对比度不低于 WCAG AA（正文 4.5:1）。
3. 变量名**不可增删改**：语义槽位固定（如 `--accent-green` 在 mono 里
   其实是灰色），业务代码只认槽位不认色相。

## index.ts 规范

默认导出一个 `ThemeManifest`（完整类型定义见 [`types.ts`](./types.ts)）：

```ts
import type { ThemeManifest } from "../types";

const theme: ThemeManifest = {
  id: "my-theme",             // 必须 = 文件夹名
  name: "My Theme 示例",       // 主题列表卡片标题
  description: "一句话描述",
  author: "you",              // 可选
  version: "1.0.0",           // 可选
  preview: ["#111", "#333"],  // 4~6 个代表色，主题列表色板预览
  chart:   { dark: {...}, light: {...} },  // 图表数据线（7 键，见 types.ts）
  chartUi: { dark: {...}, light: {...} },  // 图表轴/网格/tooltip（6 键）
};
export default theme;
```

图表色必须写**真实色值**（hex/rgba）：chart.js 画布无法解析
`var(--xxx)`。清单结构在注册时逐字段校验，不合规的主题会被跳过并在
控制台说明原因，不会拖垮其它主题。

## 新增主题 checklist

1. 复制 `mono/` 为 `themes/<你的id>/`，改 `theme.css` 里两个选择器的
   `data-theme="<你的id>"` 与全部色值（深浅两块都要）；
2. 改 `index.ts`：`id` 与文件夹名一致，更新 name/description/preview 和
   两组图表配色;
3. `pnpm run build`（或 dev）后打开后台「主题」页，新主题会自动出现在
   列表中；分别在深色/浅色模式下检查仪表盘、客户端详情、状态页、图表;
4. 对照上方红线规则自查对比度与告警语义。

## 生效机制（供排查问题）

- 注册表把所有 `theme.css` 打进主 CSS 包；切换主题 = 修改
  `<html data-theme="...">`，零网络请求、首帧无闪烁（`index.html`
  内联脚本会在 React 挂载前恢复 localStorage 中的主题）。
- `global.css` 的 `:root` / `.light` 兜底变量与 mono 保持一致，承担
  无 JS 与未知主题 id 的回退。
- 用户在后台「主题」页的选择会保存到本地（立即生效）并写入状态页
  配置（`status_pages.theme`），公开状态页对所有访客按站长所选
  主题渲染；访客自己的明暗偏好仍然生效。
- 服务端只校验主题 id 格式不校验存在性；前端遇到未知 id 一律回退
  `mono`，因此删除一个主题不会破坏任何已保存的配置。
