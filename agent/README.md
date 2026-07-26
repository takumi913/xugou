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

## 计划

- 压缩二进制文件，最小化体积，我希望能够在更多的低功耗平台运行

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

# 一条命令自卸载（移除 systemd 服务、配置文件与二进制自身，--yes 跳过确认）
sudo ./xugou-agent uninstall
```

### 配置选项

> 一般来说，建议使用命令行参数的方式来使用，网页上会提供一键安装使用的脚本

可以通过命令行参数、配置文件或环境变量来配置 Xugou Agent：

#### 命令行参数

```bash
# 指定服务器地址
./xugou-agent --server https://monitor.example.com

# 指定 API 令牌
./xugou-agent --token YOUR_API_TOKEN

# 指定收集间隔（秒）
./xugou-agent --interval 60

# 指定http 代理
./xugou-agent --proxy http://proxy.example.com:8080
```

#### 环境变量

所有配置选项也可以通过环境变量设置，环境变量名称格式为 `XUGOU_*`：

```bash
export XUGOU_SERVER=https://monitor.example.com
export XUGOU_TOKEN=YOUR_API_TOKEN
export XUGOU_INTERVAL=60
export XUGOU_LOG_LEVEL=info
```

## 开发

### 依赖项

- Go 1.18 或更高版本
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
│   └── reporter/    # 数据上报器
└── main.go          # 程序入口
```