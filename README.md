# XUGOU - 基于 CloudFlare 搭建的轻量化监控平台

<div align="center">

![XUGOU Logo](frontend/public/logo.svg)

XUGOU 是一个基于 CloudFlare 的轻量化系统监控平台，提供系统监控和状态页面功能。

</div>

## 📅 开发计划

目前已实现的主要功能：

- ✅ 系统监控 - 客户端资源监控与数据上报
- ✅ HTTP 监控 - API 接口健康检测
- ✅ 数据可视化 - 实时数据展示与历史趋势
- ✅ 状态页面 - 可定制的服务状态页面
- ✅ 告警通知 - 异常事件通过多渠道通知（电子邮件、Telegram 等）
- ✅ 用户管理 - 支持用户注册、多用户管理，可分配不同权限

## ✨ 核心特性

- 🖥️ **系统监控**

  - 实时监控 CPU、内存、磁盘、网络等系统指标
  - 支持自定义监控间隔
  - 全平台支持（agent 由 go 编写，理论上 go 能编译的平台都可以支持）

- 🌐 **HTTP 监控**

  - 支持 HTTP/HTTPS 接口监控
  - 自定义请求方法、头部和请求体
  - 响应时间、状态码和内容检查

- 📊 **数据可视化**

  - 实时数据图表展示
  - 自定义仪表盘

- 🌍 **状态页面**

  - 自定义状态页面
  - 支持多监控项展示
  - 响应式设计

- 👥 **用户管理**
  - 支持新用户注册
  - 支持多用户管理
  - 可分配不同权限

## 🏗️ 系统架构

XUGOU 采用现代化的系统架构，包含以下组件：

- **Agent**: 轻量级系统监控客户端
- **Backend**: 基于 Hono 开发的后端服务，支持部署在 Cloudflare Workers 上
- **Frontend**: 基于 React + TypeScript 的现代化前端界面

大规模设备和监控项场景下的 Cloudflare Workers + D1 容量设计，请查看 [大规模监控架构设计](./docs/大规模监控架构设计.md)。

## 🚀 快速开始

### 部署指南

默认用户名：admin 默认密码: admin123

[部署指南](./docs/部署指南.md)

### 开发指南

[开发指南](./docs/开发指南.md)

### 质量门禁

[质量门禁](./docs/质量门禁.md)

## 常见问题

[常见问题](./docs/常见问题.md)

## ⭐ 支持一下作者

<div align="center">
  <a href="https://buymeacoffee.com/real_zaunist" target="_blank">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" width="200" height="51">
  </a>
  <div style="margin-top: 12px;">
    <img src="./docs/mm_reward_qrcode.png" alt="赞赏码" width="240">
  </div>
</div>

## 🤝 贡献

欢迎所有形式的贡献，无论是新功能、bug 修复还是文档改进。

## 🏢 赞助

感谢以下赞助商支持 XUGOU 的开发：

[Cloudflare](https://www.cloudflare.com/)

## 📄 开源协议

本项目采用 MIT 协议开源，详见 [LICENSE](./LICENSE) 文件。

## 🔥 Star History

[![Star History Chart](https://api.star-history.com/svg?repos=zaunist/xugou&type=Date)](https://www.star-history.com/#zaunist/xugou&Date)
