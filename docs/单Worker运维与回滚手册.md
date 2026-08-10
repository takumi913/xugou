# XUGOU 单 Worker 运维、对账与回滚手册

更新日期：2026-08-09
适用架构：一个 `xugou-app` Worker、一个 D1、一个私有 Raw Sample R2 Bucket、`xugou-jobs`/`xugou-jobs-dlq` 两个 Queue，以及同 Bundle 导出的按 Agent 分片 `AgentRoom` Durable Object。旧全局 `MetricsBroadcaster` 已由 Wrangler v3 DO Migration 退场。

## 1. 发布前门禁

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm --dir frontend run lint
pnpm run test:frontend
pnpm run test:frontend:e2e
pnpm run test:contracts
pnpm run test:migrations
pnpm run test:contract-release
pnpm run test:modules
pnpm run test:security
pnpm run test:workers
(cd agent && go test ./... && go vet ./... && test -z "$(gofmt -l .)")
git diff --check
test -z "$(git status --porcelain)" # 发布输入必须对应一个可复现 Git Commit
```

先把生产 D1 名称和 UUID 放入当前 Shell 环境，并渲染一个权限为 `0600`、已被 `.gitignore` 排除的 Wrangler 配置。这样手工命令不会把仓库中的占位符误当成真实资源名：

```bash
umask 077
test -n "$D1_DATABASE_NAME" && test -n "$D1_DATABASE_ID"
pnpm --dir backend wrangler:render-config -- \
  --template ../wrangler.toml \
  --output ../.wrangler.production.toml
WRANGLER_CONFIG=.wrangler.production.toml
```

首次发布前创建私有归档 Bucket；后续发布只检查，不自动重建或清空：

```bash
pnpm exec wrangler r2 bucket create xugou-raw-sample-archive \
  -c "$WRANGLER_CONFIG"
pnpm exec wrangler r2 bucket info xugou-raw-sample-archive \
  -c "$WRANGLER_CONFIG"
```

Bucket 不启用公开域名，也不配置自动删除 Lifecycle。Worker 使用 `RAW_SAMPLE_ARCHIVE` Binding 直接写入，不经过 S3 Access Key 或第二个部署单元。

远程 D1 在迁移前必须保存 Bookmark、SQL Export、Preflight 和 Manifest：

```bash
umask 077
install -d -m 700 .preflight
pnpm exec wrangler d1 time-travel info "$D1_DATABASE_NAME" --json \
  -c "$WRANGLER_CONFIG" > .preflight/bookmark.json
pnpm exec wrangler d1 export "$D1_DATABASE_NAME" --remote \
  --output=.preflight/xugou.sql -c "$WRANGLER_CONFIG"
pnpm --dir backend migration:preflight -- \
  --sql-export ../.preflight/xugou.sql \
  --notification-kek-version 1 \
  > .preflight/preflight.json
pnpm exec wrangler d1 migrations apply "$D1_DATABASE_NAME" --remote \
  -c "$WRANGLER_CONFIG" | tee .preflight/migration-result.txt
pnpm exec wrangler d1 time-travel info "$D1_DATABASE_NAME" --json \
  -c "$WRANGLER_CONFIG" > .preflight/post-bookmark.json
pnpm exec wrangler d1 export "$D1_DATABASE_NAME" --remote \
  --output=.preflight/xugou-post.sql -c "$WRANGLER_CONFIG"
pnpm --dir backend migration:preflight -- \
  --sql-export ../.preflight/xugou-post.sql \
  --notification-kek-version 1 \
  > .preflight/post-preflight.json
pnpm --dir backend migration:postflight -- \
  --mode expand \
  --before ../.preflight/preflight.json \
  --after ../.preflight/post-preflight.json \
  --output ../.preflight/postflight.json
pnpm --dir backend migration:manifest -- \
  --preflight ../.preflight/preflight.json \
  --sql-export ../.preflight/xugou.sql \
  --bookmark ../.preflight/bookmark.json \
  --migration-result ../.preflight/migration-result.txt \
  --postflight ../.preflight/postflight.json \
  --post-sql-export ../.preflight/xugou-post.sql \
  --post-bookmark ../.preflight/post-bookmark.json \
  --git-sha "$(git rev-parse HEAD)" \
  --output ../.preflight/migration-manifest.json
chmod 600 .preflight/*
```

`readyForExpand=true` 是 Expand 发布条件。Expand Postflight 验证核心行数和十个旧源域均未减少，允许守恒投影仍在等待 Backfill；Contract Postflight 使用 `--mode contract`，要求十个守恒公式全部归零。旧字段/旧表的 Contract 清理还要求 `readyForCredentialContract=true`、Release Readiness 全部通过、对应 v1 静默窗口满足，并保存完整证据。

## 2. 发布后 Readiness 核验

管理员登录后，从 Operations 页面下载或通过已登录 Cookie 请求：

```bash
curl --fail --silent --show-error \
  --cookie "$XUGOU_ADMIN_COOKIE" \
  "$XUGOU_BASE_URL/api/v2/operations/release-readiness" \
  > .preflight/release-readiness.json

pnpm --dir backend operations:verify-readiness -- \
  --file ../.preflight/release-readiness.json \
  --mode release
```

门禁模式：

| 模式 | 使用时机 |
|---|---|
| `release` | 每次发布后的 Queue、Outbox、DLQ、迁移、凭据、Publication 总门禁 |
| `contract-worker` | 确认当前 Bundle 已具备 Contract 模式与物理删表后运行能力 |
| `credential-contract` | 清理旧明文 Credential/Secret 和旧历史结构前 |
| `management-v1-sunset` | 删除管理端 v1 Adapter 前 |
| `agent-v1-sunset` | 删除旧 Agent register/report 协议前 |
| `all` | 最终 Contract 发布前 |

核验 JSON、Migration Manifest、Git SHA 和 Cloudflare Version ID 放入同一发布证据包。`unverified_raw_sample_archive_batches` 必须为 0；Readiness 失败时按 `failed_checks` 逐项处理，不以人工口头确认覆盖失败门禁。

## 3. Queue 积压、DLQ 与重放

### 3.1 暂停与恢复

Consumer 异常或需要冻结副作用时：

```bash
pnpm exec wrangler queues pause-delivery xugou-jobs -c "$WRANGLER_CONFIG"
pnpm exec wrangler queues pause-delivery xugou-jobs-dlq -c "$WRANGLER_CONFIG"
pnpm exec wrangler queues info xugou-jobs -c "$WRANGLER_CONFIG"
pnpm exec wrangler queues info xugou-jobs-dlq -c "$WRANGLER_CONFIG"
```

修复并完成账本核对后：

```bash
pnpm exec wrangler queues resume-delivery xugou-jobs -c "$WRANGLER_CONFIG"
pnpm exec wrangler queues resume-delivery xugou-jobs-dlq -c "$WRANGLER_CONFIG"
```

暂停期间 Queue 仍接收消息，消息继续受平台保留期约束。生产环境默认不执行 `queues purge`；坏消息由 DLQ 账本逐条重放或终止，保留 `failure_id`、原 Message ID、错误和操作审计。

### 3.2 逐条重放

1. Operations → Queue Failures 筛选 `open`。
2. 确认对应代码修复已经发布，检查 `source_kind/source_id` 和最近错误。
3. 点击“重放”；服务端以原稳定消息 ID 进入同一 Queue，Inbox/Job Ledger 负责幂等。
4. Readiness 中 `open_queue_failures=0`、相关 backlog/lag 回到阈值后保存核验 JSON。
5. 明确无需执行的记录使用“终止”，该操作写入 Security Audit，不直接删除记录。

## 4. Worker 代码回切

```bash
pnpm exec wrangler deployments list -c "$WRANGLER_CONFIG"
pnpm exec wrangler deployments status -c "$WRANGLER_CONFIG"
pnpm exec wrangler rollback VERSION_ID \
  --message "rollback: INCIDENT_ID" -c "$WRANGLER_CONFIG"
```

Expand 迁移只新增表/列时，先回切 Worker 代码，D1 新结构可保留。代码回切后执行 Release Readiness，并核对旧版是否仍能处理当前 Queue Envelope；涉及 Envelope Contract 的回切先暂停 Queue，再部署可兼容版本。

## 5. D1 Bookmark 恢复

D1 原位恢复会覆盖目标时间点之后的数据，并取消执行中的查询。执行顺序：

1. 记录事件编号、目标 Git SHA、目标 Worker Version、迁移证据包。
2. 暂停主 Queue 与 DLQ 投递。
3. 保存恢复前 Bookmark 和 SQL Export，作为撤销恢复的证据。
4. 回切到与目标 Bookmark Schema 兼容的 Worker Version。
5. 使用发布证据中的 Bookmark 恢复 D1。
6. 重新执行只读 Preflight、`PRAGMA integrity_check`、`PRAGMA foreign_key_check`。
7. 验证管理登录、Monitor/Agent 读取、活动 Status Publication 和 Readiness。
8. 恢复 Queue 投递，观察 backlog、lag、DLQ 与结构化错误日志。

命令模板：

```bash
umask 077
install -d -m 700 .recovery
pnpm exec wrangler queues pause-delivery xugou-jobs -c "$WRANGLER_CONFIG"
pnpm exec wrangler queues pause-delivery xugou-jobs-dlq -c "$WRANGLER_CONFIG"

pnpm exec wrangler d1 time-travel info "$D1_DATABASE_NAME" --json \
  -c "$WRANGLER_CONFIG" \
  > ".recovery/pre-restore-bookmark-$(date -u +%Y%m%dT%H%M%SZ).json"
pnpm exec wrangler d1 export "$D1_DATABASE_NAME" --remote \
  --output=".recovery/pre-restore.sql" -c "$WRANGLER_CONFIG"

pnpm exec wrangler rollback VERSION_ID --message "db restore: INCIDENT_ID" \
  -c "$WRANGLER_CONFIG"
pnpm exec wrangler d1 time-travel restore "$D1_DATABASE_NAME" \
  --bookmark "$TARGET_BOOKMARK" --json \
  -c "$WRANGLER_CONFIG" \
  > .recovery/restore-result.json

pnpm exec wrangler d1 export "$D1_DATABASE_NAME" --remote \
  --output=.recovery/post-restore.sql -c "$WRANGLER_CONFIG"
pnpm --dir backend migration:preflight -- \
  --sql-export ../.recovery/post-restore.sql \
  > .recovery/post-restore-preflight.json
chmod 600 .recovery/*

pnpm exec wrangler queues resume-delivery xugou-jobs -c "$WRANGLER_CONFIG"
pnpm exec wrangler queues resume-delivery xugou-jobs-dlq -c "$WRANGLER_CONFIG"
```

恢复命令返回的 `previous_bookmark` 是撤销本次恢复的依据，应与事件记录一并保存。Time Travel 的可用时间窗取决于账户计划，发布证据中的 Bookmark 仍需在平台有效期内使用。

## 6. Raw Sample R2 归档、校验与清理

同一 Worker 每 5 分钟为 Agent/Monitor 各归档一批超过 `RAW_SAMPLE_ARCHIVE_MIN_AGE_DAYS` 的不可变样本。对象路径为 `raw-samples/v1/<domain>/YYYY/MM/DD/<sha256>.jsonl`，D1 账本记录对象 Key、字节数、SHA-256、R2 Version/ETag、源行数和验证时间。

核验最近归档状态：

```bash
pnpm exec wrangler d1 execute "$D1_DATABASE_NAME" --remote --command \
  "SELECT domain,status,count(*) batches,sum(source_rows) rows FROM raw_sample_archive_batches GROUP BY domain,status ORDER BY domain,status" \
  -c "$WRANGLER_CONFIG"

pnpm exec wrangler d1 execute "$D1_DATABASE_NAME" --remote --command \
  "SELECT id,domain,object_key,content_sha256,object_size_bytes,source_rows,r2_etag,verified_at,last_error FROM raw_sample_archive_batches ORDER BY updated_at DESC LIMIT 20" \
  -c "$WRANGLER_CONFIG"
```

处理规则：

1. `pending`/`failed` Batch 会在源行仍未建立 verified member 时按相同内容重新生成；对象 Key 含内容 SHA-256，重试保持幂等。
2. R2 `put` 同时提交 SHA-256；随后强一致 `head` 必须匹配 Size、Checksum 和 Custom Metadata，才把 Batch/Member 以 D1 Batch 标记为 verified。
3. `RAW_SAMPLE_ARCHIVE_DELETE_ENABLED` 默认 `false`，因此 Expand/观察窗口只归档不删源。回滚窗口和恢复演练结束后显式设为 `true`，每日清理才匹配 `member -> verified batch` 且早于各自 Retention Cutoff 的源行；没有 Member、Batch 未验证或校验字段缺失时保留 D1 原始样本。
4. 已验证 Agent Sample 删除后，只有 Member 数覆盖原 `sample_count` 才把已处理 Report 的 `payload_json` 清为 `{}`；Report ID/Digest/处理账本继续保留用于幂等与审计。
5. Bucket 对象及 `raw_sample_archive_batches/raw_sample_archive_members` 账本长期保留。R2 对象恢复由 `backend/src/platform/archive/RawSampleRestore.ts` 的 `restoreVerifiedRawSampleBatch()` 执行：先逐项核对 Batch 状态、对象 Size、SHA-256、R2 Checksum、Custom Metadata、JSONL Header、Member 集合和源行数，再按 `source_key` 与源表主键执行 `INSERT OR IGNORE`。恢复后重新运行行数、外键、完整性与 SHA-256 对账；重复执行应全部计入 `deduplicatedRows`。

## 7. 平台告警与处置阈值

同一 Worker 已输出 JSON 日志和自动 Trace。Cloudflare Workers Logs/Traces、Queues 面板至少建立以下告警：

| 信号 | 默认阈值 | 首要动作 |
|---|---:|---|
| `result=failure` 的 Worker 调用 | 5 分钟内持续出现 | 按 `trace_id/release_version/operation` 聚合，定位首个稳定错误码 |
| 主 Queue backlog | `>100` | 检查 Consumer 错误与 D1 延迟；代码错误时暂停投递 |
| 主 Queue oldest lag | `>300s` | 核对租约、重试和 Worker CPU/子请求限制 |
| Outbox backlog/lag | `>100` / `>300s` | 检查 Relay 与 Queue Publish，保留 pending 行等待恢复 |
| Notification backlog | `>100` | 检查 Provider 分类、重试间隔和 Endpoint Secret 解密 |
| Open DLQ | `>0` | 逐条确认后重放或终止 |
| Open Migration Anomaly | `>0` | Operations 中修复源值后 retry，或附注后 ignore |
| Publication age | `>300s` | 检查 `status.rebuild.requested` Outbox 与 Publication Consumer |

结构化日志查询不写入 Authorization、Cookie、Token、Secret、通知完整配置或请求正文。平台日志负责故障定位，D1 Job/Outbox/Attempt/Failure/Migration 账本负责业务事实和可恢复状态。

## 8. Contract 发布签核

最终清理旧字段、旧表或 v1 Adapter 前，证据包必须同时包含：

- 对应 Git SHA 的 Migration Manifest、SQL Export SHA-256、迁移输出和 Bookmark。
- `operations:verify-readiness --mode all` 成功结果。
- 所有历史源表 `source_rows = mapped_rows + anomaly_rows`，活动 anomaly 为零或已有带备注的接受记录。
- 管理端与 Agent v1 各自满足配置静默窗口。
- Worker 回切和 D1 Bookmark 恢复演练记录。
- Queue 重复投递、DLQ 重放、Cron 重叠和迁移租约测试结果。

Contract 清理作为独立发布执行，清理前再生成一套新 Bookmark、Export 和 Manifest。

### 8.1 编译 Contract 证据包

Contract 批次必须重新导出数据库并使用 Migration Manifest v2；v2 Manifest 会把十个迁移域的显式守恒公式与 SQLite 完整性结果纳入签名证据。完成 `operations:verify-readiness --mode all` 后执行：

```bash
pnpm --dir backend migration:postflight -- \
  --mode contract \
  --before ../.preflight/preflight.json \
  --after ../.preflight/post-preflight.json \
  --output ../.preflight/postflight.json
# 使用以上 Contract Postflight、同批次双份 Export/Bookmark 重新生成 Manifest v2。
pnpm --dir backend contract:prepare -- \
  --preflight ../.preflight/preflight.json \
  --migration-manifest ../.preflight/migration-manifest.json \
  --readiness ../.preflight/release-readiness.json \
  --bookmark ../.preflight/bookmark.json \
  --sql-export ../.preflight/xugou.sql \
  --postflight ../.preflight/postflight.json \
  --post-bookmark ../.preflight/post-bookmark.json \
  --post-sql-export ../.preflight/xugou-post.sql \
  --git-sha "$(git rev-parse HEAD)" \
  --output ../.preflight/contract-release.json
```

本节的 Preflight/Postflight/Manifest 均来自 Backfill 与十域守恒归零后的独立 Contract 批次，不复用 Expand 发布时的 `mode=expand` 证据。

编译器逐项核对：Git SHA、迁移前后两份 SQL Export 字节数/SHA-256、迁移前后 Bookmark、Postflight、Readiness 五类 Gate（含 `contract_worker_ready`）、全部 Check、`quick_check`、`integrity_check`、外键和十个迁移域的等式；证据顺序固定为 Preflight → Postflight → Readiness。任一证据漂移即退出非零。输出文件权限固定为 `0600`，包含摘要、计数和清理前 Readiness Snapshot，不包含 SQL Export 正文、Bookmark 数据或任何 Secret。

完整 SQL Export 含旧 Agent Token、通知配置及业务数据，不进入 GitHub Artifact；它必须与 `contract-release.json` 一起保存到加密、限权存储至少 400 天。仓库中的 `backend/contract/cleanup-plan.json` 描述单 Worker Contract 发布顺序和 Identity Anchor 原位裁剪范围，`backend/contract/retention-policy.json` 是清理后的数据保留基线。两者的 SHA-256 也进入证据包，变更必须重新签核。

### 8.2 渲染并演练一次性 Contract SQL

先把同一 Worker 以 `DATA_COMPATIBILITY_MODE=contract` 发布；此时旧表仍在，但 v1、旧 JWT、Legacy Read、Dual Write 与 Backfill 已停止。随后暂停两个 Queue，等待 `async_jobs`、`domain_outbox`、活动 Notification Message 和 Open DLQ 全部归零，再渲染 SQL：

```bash
umask 077
pnpm --dir backend contract:render -- \
  --bundle ../.preflight/contract-release.json \
  --output ../.preflight/contract.sql

ls -l .preflight/contract.sql # 权限必须为仅当前用户读写（0600）
```

渲染器只接受 v2 Ready Bundle 和严格 allow-list 的动态 `agent_metrics_history_*` 表名。SQL 不含 `BEGIN/COMMIT`，交由 D1 的文件执行隐式事务处理；不得手工编辑。先把最终 SQL Export 恢复到隔离的本地/演练 D1，应用全部 Expand Migration 后执行同一文件：

```bash
pnpm exec wrangler d1 execute "$D1_DATABASE_NAME" --local \
  --file=.preflight/contract.sql -c "$WRANGLER_CONFIG"
pnpm exec wrangler d1 execute "$D1_DATABASE_NAME" --local \
  --command="SELECT count(*) AS violations FROM pragma_foreign_key_check;" \
  -c "$WRANGLER_CONFIG"
```

演练必须验证：Agent/Monitor/Channel/Template ID 集合不变，Report/Sample/Rollup/Credential/Message 行数不变，旧表和旧敏感列消失，`agents.anchor_nonce` 全部为 `contract-anchor:<id>`，`contract_release_state.phase=active`，物理清理后的 Worker Runtime 全量测试通过。

### 8.3 生成双人执行授权

复制 `backend/contract/production-signoff.example.json`，填写六项生产证据及两名不同人员的审批记录。证据完成时间、输入输出 SHA-256、环境、操作者和加密存储位置均为必填项。随后用发布审批 Ed25519 私钥生成独立签名，并编译最终执行授权：

```bash
umask 077
openssl pkeyutl -sign -rawin \
  -inkey "$CONTRACT_APPROVAL_PRIVATE_KEY" \
  -in .preflight/production-signoff.json \
  -out .preflight/production-signoff.sig

pnpm --dir backend contract:authorize -- \
  --bundle ../.preflight/contract-release.json \
  --contract-sql ../.preflight/contract.sql \
  --signoff ../.preflight/production-signoff.json \
  --signature ../.preflight/production-signoff.sig \
  --public-key ../.preflight/approval-public-key.pem \
  --output ../.preflight/contract-authorization.json
```

授权编译器重新核对 Bundle、Contract SQL、Migration Manifest、迁移前后 Bookmark 的 SHA-256，验证六项证据全部零差异、静默窗口、R2 HEAD/恢复读取、隔离恢复门禁、Queue/DLQ/Inbox/Outbox/Failure Ledger 归零、两名审批人互异以及 Ed25519 签名。输出权限固定为 `0600`。审批私钥仅进入受控签名环境，不进入证据目录。

### 8.4 远程执行、核验与恢复投递

再次确认 Bookmark、Export、Bundle、Contract SQL、Production Signoff、签名和 `contract-authorization.json` 均已保存到加密限权存储，然后执行：

```bash
pnpm exec wrangler d1 execute "$D1_DATABASE_NAME" --remote \
  --file=.preflight/contract.sql -c "$WRANGLER_CONFIG"

curl --fail --silent --show-error \
  --cookie "$XUGOU_ADMIN_COOKIE" \
  "$XUGOU_BASE_URL/api/v2/operations/release-readiness" \
  > .preflight/post-contract-readiness.json
pnpm --dir backend operations:verify-readiness -- \
  --file ../.preflight/post-contract-readiness.json \
  --mode all
```

远程 Readiness 必须返回 `data_compatibility_mode=contract`、`contract_worker_ready=true`、`contract_evidence.digest_valid=true`，并且所有实时 Check 为绿。随后各恢复一次 DLQ 与主 Queue 投递，观察一个完整 Monitor/Agent 周期；任一 Identity/FK/数据行断言失败时保持 Queue 暂停，使用证据绑定的 Bookmark/SQL Export 恢复 D1，并回切同一 Worker Version。

## 9. 平台依据

- [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Cloudflare Queues Pause and Purge](https://developers.cloudflare.com/queues/configuration/pause-purge/)
- [Cloudflare Queues Dead Letter Queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
- [Cloudflare Workers Best Practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
