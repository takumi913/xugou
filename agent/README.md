# Xugou Agent

Xugou Agent 是一个系统监控客户端，用于收集系统信息并上报到监控服务器。它可以收集 CPU、内存、磁盘、网络等系统信息，并定期上报到指定的服务器。

## 功能特点

- 收集系统基本信息（主机名、操作系统、平台等）
- 监控 CPU 使用率和负载
- 监控内存使用情况
- 监控磁盘使用情况
- 监控网络接口状态
- 支持自定义收集间隔
- 支持自定义监控硬盘设备和网络设备
- 支持配置文件和环境变量配置
- 使用 v4 `report_id`、gzip 批次和最多 100 条样本的分块上报
- 使用 v2 Bearer 注册；Enrollment/Credential 只进入 Authorization Header，不进入 JSON Body
- 采集结果先进入权限为 `0700/0600` 的持久化 Spool，进程重启后继续投递
- Spool 有容量上限，网络重试使用指数退避和随机抖动
- 自升级原子读取 `latest/manifest.json` 中内嵌 Ed25519 签名的清单，再验证平台、版本、大小和 SHA-256；替换健康检查失败会恢复旧版本

## 安装

### 从源码构建

```bash
git clone https://github.com/zaunist/xugou.git
cd agent
go build -o xugou-agent
```

## 使用方法

### 基本命令

```bash
# 显示帮助信息
./xugou-agent --help

# 显示版本信息
./xugou-agent version

# 启动客户端
./xugou-agent start

# 查看运行状态与配置（版本、配置文件、systemd 服务状态、服务器连通性）
./xugou-agent status

# 一条命令自升级到最新版本（systemd 环境通常需要 sudo，升级后自动重启服务）
sudo ./xugou-agent update

# 仅检查是否有新版本，不执行升级
./xugou-agent update --check

# 使用自建分发源时传入签名清单，而不是直接传入二进制
./xugou-agent update --url https://mirror.example/manifest.json

# 一条命令自卸载（移除 systemd 服务、配置文件与二进制自身，--yes 跳过确认）
sudo ./xugou-agent uninstall
```

### 平台能力矩阵

| 能力 | Linux | macOS | Windows |
| --- | --- | --- | --- |
| 签名清单 / SHA-256 校验 | 支持 | 支持 | 支持 |
| 自动替换与新版探活 | 原子 Rename | 原子 Rename | 独立 Helper 等待文件锁释放 |
| 探活失败恢复旧版 | 支持 | 支持 | 支持 |
| 服务恢复 | systemd 自动重启 | 控制台启动 | Windows Service 或控制台自动恢复 |
| 配置、Token、Spool 路径 | 保持 | 保持 | 保持（支持含空格路径） |

Windows Helper 只复制并替换已通过签名、大小、摘要和 PE 魔数校验的二进制；主进程退出后执行替换，随后运行 `version --short` 核对版本。失败时从 `.old` 恢复，Helper 退出后延迟清理自身。

### 配置选项

> 一般来说，建议使用命令行参数的方式来使用，网页上会提供一键安装使用的脚本

可以通过命令行参数、配置文件或环境变量来配置 Xugou Agent：

#### 命令行参数

```bash
# 指定服务器地址
./xugou-agent --server https://monitor.example.com

# 推荐：从权限为 0600 的文件读取 API 凭据，凭据不会出现在进程参数中
install -m 600 /dev/null ~/.xugou-agent.token
printf '%s' 'YOUR_API_TOKEN' > ~/.xugou-agent.token
./xugou-agent --token-file ~/.xugou-agent.token

# 独立指定采集与批量上报间隔
./xugou-agent --collect-interval 60 --report-interval 60

# 设置 Spool 容量和单请求压缩后大小
./xugou-agent --spool-max-bytes 67108864 --report-max-compressed-bytes 65536

# 指定http 代理
./xugou-agent --proxy http://proxy.example.com:8080
```

#### 环境变量

所有配置选项也可以通过环境变量设置，环境变量名称格式为 `XUGOU_*`：

```bash
export XUGOU_SERVER=https://monitor.example.com
export XUGOU_TOKEN_FILE=$HOME/.xugou-agent.token
export XUGOU_COLLECT_INTERVAL=60
export XUGOU_REPORT_INTERVAL=60
export XUGOU_SPOOL_DIR=$HOME/.xugou-spool
# 服务端 update=1 使用的自建签名清单地址
export XUGOU_UPDATE_MANIFEST_URL=https://mirror.example/latest/manifest.json
```

配置优先级为：显式新参数 > 环境变量 > 配置文件 > 旧 `--interval` Alias > 默认值。
旧 `--interval` 仅补齐尚未显式设置的采集/上报间隔。

### 持久化与重试语义

1. 每次采集成功后先写入本地 Spool，文件中不保存 Agent Credential。
2. 上报时按最老样本组批，最多 100 条且压缩后不超过配置上限。
3. 首次组批会原子保存 `inflight.json` 和 UUID `report_id`；HTTP 超时、5xx 与进程重启后重用相同信封。
4. 服务端返回 2xx 后通过两阶段 Ack 清理样本；Ack 中途退出时，下一次启动会完成清理。
5. 默认 Spool 上限为 64 MiB；达到上限时保留 inflight，并从最老的待组批样本开始清理，同时累计丢弃计数。

## 开发

### 依赖项

- Go 1.26.5
- github.com/spf13/cobra
- github.com/spf13/viper
- github.com/shirou/gopsutil/v3

### 项目结构

```
agent/
├── cmd/
│   └── agent/       # 命令行命令
│       ├── root.go  # 根命令
│       ├── start.go # 启动命令
│       └── version.go # 版本命令
├── pkg/
│   ├── collector/   # 数据收集器
│   ├── reporter/    # v4 gzip 数据上报器
│   └── spool/       # 持久化样本、稳定 report_id 与两阶段 Ack
└── main.go          # 程序入口
```
