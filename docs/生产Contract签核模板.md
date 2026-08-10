# 生产 Contract 双人签核模板

> 每次生产 Contract 批次复制一份本模板。所有时间使用 UTC RFC3339；所有输入、输出文件填写 SHA-256。SQL Export 进入加密限权存储，不上传普通 CI Artifact。
> 机器校验使用 [`../backend/contract/production-signoff.example.json`](../backend/contract/production-signoff.example.json)；完成本表后同步填写 JSON、生成 Ed25519 独立签名，并运行 `pnpm --dir backend contract:authorize`。

## 发布身份

| 字段 | 值 |
| --- | --- |
| 环境 | production |
| Git SHA |  |
| Worker Version ID |  |
| D1 Database / pre Bookmark |  |
| D1 post Bookmark |  |
| Migration Manifest SHA-256 |  |
| Contract Bundle SHA-256 |  |
| Contract SQL SHA-256 |  |

## 六项证据

| # | 检查 | 开始/结束时间 | 操作者 | 输入摘要 | 输出摘要 | 结果/差额 | 证据位置 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | D1 Backfill 批次、游标、前后计数、重试与十域守恒 |  |  |  |  |  |  |
| 2 | R2 Raw Sample SHA-256、Size、ETag、权限与恢复读取抽检 |  |  |  |  |  |  |
| 3 | 隔离环境 D1 Bookmark 恢复及完整门禁 |  |  |  |  |  |  |
| 4 | Management v1 / Agent v1 / `latest/` 静默窗口 |  |  |  |  |  |  |
| 5 | Queue 冻结后的 Job、DLQ、Inbox、Outbox、Failure Ledger 核对 |  |  |  |  |  |  |
| 6 | 最终证据包、独立 Contract SQL、签名与演练结果 |  |  |  |  |  |  |

## 强制断言

- [ ] `postflight.ready=true`，SQLite quick/integrity/foreign-key 全部通过。
- [ ] 十个迁移域 `difference=0`，核心业务行数无减少。
- [ ] R2 抽检对象 HEAD 元数据、下载摘要与 D1 Batch/Member 一致。
- [ ] 恢复演练后 `pnpm run test:all` 与 Release Readiness 通过。
- [ ] 静默窗口满足配置天数，兼容命中为 0。
- [ ] Pending/Retry/Processing、DLQ、开放 Failure/Anomaly 均为 0。
- [ ] SQL Export、Bookmark、Bundle、Contract SQL 已保存到加密限权存储至少 400 天。

## 双人复核

| 角色 | 姓名 | 复核时间 | 结论 | 签名/审批记录 |
| --- | --- | --- | --- | --- |
| 执行人 |  |  |  |  |
| 独立复核人 |  |  |  |  |

任一强制断言未勾选时，本批次停留在 Expand/Verify 阶段。执行与恢复命令以 [`单Worker运维与回滚手册.md`](单Worker运维与回滚手册.md) 为准。
