#!/usr/bin/env bash

set -e

# --- 配置 ---
AGENT_NAME="xugou-agent"
DOWNLOAD_BASE_URL="https://dl.xugou.mdzz.uk/latest"
AGENT_INSTALL_PATH="/usr/local/bin/${AGENT_NAME}"
SERVICE_NAME="${AGENT_NAME}.service"
SERVICE_FILE_PATH="/etc/systemd/system/${SERVICE_NAME}"

# --- 默认参数 ---
SERVER_URL=""
AGENT_TOKEN=""
AGENT_COLLECT_INTERVAL="1"
AGENT_REPORT_INTERVAL="60"

# --- 环境变量相关函数 ---
detect_shell_rc() {
  if [ -n "$ZSH_VERSION" ] && [ -f "$HOME/.zshrc" ]; then
    echo "$HOME/.zshrc"
  elif [ -f "$HOME/.bashrc" ]; then
    echo "$HOME/.bashrc"
  elif [ -f "$HOME/.profile" ]; then
    echo "$HOME/.profile"
  else
    echo "$HOME/.bashrc"
  fi
}

set_env_vars() {
  local rc_file
  rc_file=$(detect_shell_rc)
  # 先去除已有的同名变量
  grep -v '^export XUGOU_SERVER=' "$rc_file" 2>/dev/null | grep -v '^export XUGOU_TOKEN=' > "${rc_file}.tmp" || true
  mv "${rc_file}.tmp" "$rc_file"
  echo "export XUGOU_SERVER=\"$SERVER_URL\"" >> "$rc_file"
  echo "export XUGOU_TOKEN=\"$AGENT_TOKEN\"" >> "$rc_file"
  
  echo "已将 XUGOU_SERVER 和 XUGOU_TOKEN 写入 $rc_file"

  # 让环境变量立即生效（仅限交互式 shell）
  if [[ $- == *i* ]]; then
    source "$rc_file"
    echo "已自动刷新环境变量（source $rc_file）"
  else
    echo "请手动执行：source $rc_file 以使环境变量立即生效"
  fi
}

read_env_vars() {
  if [ -z "$XUGOU_SERVER" ]; then
    XUGOU_SERVER=$(grep '^export XUGOU_SERVER=' "$(detect_shell_rc)" 2>/dev/null | tail -n1 | cut -d= -f2- | sed 's/^"//;s/"$//')
  fi
  if [ -z "$XUGOU_TOKEN" ]; then
    XUGOU_TOKEN=$(grep '^export XUGOU_TOKEN=' "$(detect_shell_rc)" 2>/dev/null | tail -n1 | cut -d= -f2- | sed 's/^"//;s/"$//')
  fi
}

# --- 辅助函数 ---
print_usage() {
  echo "用法: $0 [command] [options]"
  echo ""
  echo "Commands:"
  echo "  install (default)    下载、安装并配置 ${AGENT_NAME}."
  echo "                       在 Linux 上会尝试注册为 systemd 服务."
  echo "  update               更新 ${AGENT_NAME} 到最新版."
  echo "                       会自动读取环境变量并重启 agent."
  echo "  uninstall            卸载 ${AGENT_NAME}."
  echo "                       在 Linux 上会尝试移除 systemd 服务."
  echo "  help                 显示此帮助信息."
  echo ""
  echo "Options for 'install' command:"
  echo "  --server <url>       必需. 服务器地址 (例如: http://localhost:8787)."
  echo "  --token <token>      必需. Agent 认证令牌."
  echo "  --collect-interval <seconds> 可选. 轻量指标采集间隔 (默认为 ${AGENT_COLLECT_INTERVAL} 秒)."
  echo "  --report-interval <seconds>  可选. HTTP 批量上报间隔 (默认为 ${AGENT_REPORT_INTERVAL} 秒)."
  echo ""
  echo "示例:"
  echo "  $0 install --server http://localhost:8787 --token yoursecrettoken"
  echo "  $0 --server http://localhost:8787 --token yoursecrettoken --collect-interval 1 --report-interval 60"
  echo "  $0 update"
  echo "  $0 uninstall"
  exit 1
}

# --- SUDO 权限处理 ---
SUDO_CMD=""
if [[ $EUID -ne 0 ]]; then
  if command -v sudo &> /dev/null; then
    SUDO_CMD="sudo"
  else
    echo "错误: 此脚本需要 root 权限或 sudo 命令来进行某些操作 (例如 systemd 服务管理)。" >&2
    # For non-Linux or non-service operations, we might not need to exit immediately.
    # We'll check specifically where sudo is needed.
  fi
fi

# --- 检测操作系统和架构 ---
OS_TYPE=$(uname -s)
OS_ARCH=$(uname -m)
PLATFORM=""
ARCH=""
EXTENSION=""

detect_os_arch() {
  case "$OS_TYPE" in
    Linux)
      PLATFORM="linux"
      ;;
    Darwin)
      PLATFORM="darwin"
      ;;
    CYGWIN*|MINGW*|MSYS*|Windows_NT)
      PLATFORM="windows"
      EXTENSION=".exe"
      ;;
    *)
      echo "错误: 不支持的操作系统: $OS_TYPE" >&2
      exit 1
      ;;
  esac

  case "$OS_ARCH" in
    x86_64|amd64)
      ARCH="amd64"
      ;;
    arm64|aarch64)
      ARCH="arm64"
      ;;
    *)
      # For Windows, we might have 386, but our download URL structure doesn't show it.
      # We'll rely on the user to pick the correct Windows binary if OS_ARCH is not amd64/arm64.
      if [ "$PLATFORM" != "windows" ]; then
        echo "错误: 不支持的系统架构: $OS_ARCH for $PLATFORM" >&2
        exit 1
      fi
      # For Windows, if arch is not amd64 or arm64, we'll let the user decide.
      # The script will print download links for common architectures.
      ;;
  esac
}

# --- 内置自管理命令提示 ---
# $1: agent 命令路径（如 xugou-agent 或 ./xugou-agent）
# $2: 是否需要 sudo（"sudo" 或空）
print_builtin_commands() {
  local agent_cmd="$1"
  local sudo_prefix="$2"
  [ -n "$sudo_prefix" ] && sudo_prefix="${sudo_prefix} "
  echo ""
  echo "常用命令 (Agent 已内置自管理命令):"
  echo "  ${agent_cmd} status                查看运行状态与配置"
  echo "  ${sudo_prefix}${agent_cmd} update             一条命令升级到最新版本"
  echo "  ${sudo_prefix}${agent_cmd} uninstall          一条命令卸载 Agent"
}

# --- 安装 Agent ---
do_install() {
  detect_os_arch

  # --- 校验必需参数 for install ---
  if [ -z "$SERVER_URL" ]; then
    echo "错误: --server 参数是 'install' 命令所必需的。" >&2
    print_usage
  fi
  if [ -z "$AGENT_TOKEN" ]; then
    echo "错误: --token 参数是 'install' 命令所必需的。" >&2
    print_usage
  fi

  echo "开始安装 ${AGENT_NAME}..."
  echo "服务器地址: ${SERVER_URL}"
  echo "Agent 令牌: **** (已隐藏)"
  echo "轻量采集间隔: ${AGENT_COLLECT_INTERVAL} 秒"
  echo "HTTP 批量上报间隔: ${AGENT_REPORT_INTERVAL} 秒"

  if [ "$PLATFORM" = "windows" ]; then
    echo ""
    echo "检测到 Windows 系统。"
    echo "此脚本的自动服务注册功能主要为 Linux 设计。"
    echo "请从以下地址手动下载适用于 Windows 的 ${AGENT_NAME}${EXTENSION}："
    echo "  ${DOWNLOAD_BASE_URL}/${AGENT_NAME}-windows-amd64${EXTENSION} (针对 AMD64/x86_64)"
    echo "  ${DOWNLOAD_BASE_URL}/${AGENT_NAME}-windows-arm64${EXTENSION} (针对 ARM64)"
    echo "下载后，您可以使用以下命令运行 (请替换参数值):"
    echo "  .\\${AGENT_NAME}${EXTENSION} start --server \"${SERVER_URL}\" --token \"${AGENT_TOKEN}\" --collect-interval \"${AGENT_COLLECT_INTERVAL}\" --report-interval \"${AGENT_REPORT_INTERVAL}\""
    exit 0
  fi

  if [ -z "$ARCH" ]; then
      echo "错误: 无法确定系统架构 ($OS_ARCH) 以进行自动下载。" >&2
      echo "请检查您的系统或手动下载 Agent。" >&2
      exit 1
  fi

  DOWNLOAD_URL="${DOWNLOAD_BASE_URL}/${AGENT_NAME}-${PLATFORM}-${ARCH}${EXTENSION}"
  LOCAL_AGENT_DOWNLOAD_PATH="./${AGENT_NAME}${EXTENSION}" # Download to current dir first

  echo "检测到系统: ${PLATFORM}-${ARCH}"
  echo "将从以下地址下载 Agent: ${DOWNLOAD_URL}"

  if command -v curl >/dev/null 2>&1; then
    curl -sSL "${DOWNLOAD_URL}" -o "${LOCAL_AGENT_DOWNLOAD_PATH}"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "${LOCAL_AGENT_DOWNLOAD_PATH}" "${DOWNLOAD_URL}"
  else
    echo "错误: 系统中未找到 curl 或 wget。请先安装其中一个。" >&2
    exit 1
  fi

  if [ ! -f "${LOCAL_AGENT_DOWNLOAD_PATH}" ] || [ ! -s "${LOCAL_AGENT_DOWNLOAD_PATH}" ]; then
      echo "错误: Agent 下载失败或文件为空。请检查 URL 或网络连接。" >&2
      echo "URL: ${DOWNLOAD_URL}" >&2
      # Attempt to show download error if curl was used and failed with HTTP error
      if command -v curl >/dev/null 2>&1; then
        echo "尝试再次下载并显示详细错误:"
        curl -SL --fail "${DOWNLOAD_URL}" -o "${LOCAL_AGENT_DOWNLOAD_PATH}" || echo "Curl 下载失败，请检查上述错误信息。"
      fi
      exit 1
  fi
  echo "Agent 下载成功: ${LOCAL_AGENT_DOWNLOAD_PATH}"
  chmod +x "${LOCAL_AGENT_DOWNLOAD_PATH}"
  echo "已为 Agent 添加执行权限。"

  if [ "$PLATFORM" = "linux" ] && command -v systemctl &> /dev/null; then
    echo "检测到 Linux 系统并支持 systemd。将尝试注册为服务..."
    if [ -z "$SUDO_CMD" ] && [[ $EUID -ne 0 ]]; then
        echo "错误: 需要 sudo 权限来安装 systemd 服务，但 sudo 命令未找到或您不是 root 用户。" >&2
        echo "您可以尝试使用 root 用户运行此脚本，或手动将 ${LOCAL_AGENT_DOWNLOAD_PATH} 移动到 PATH 路径并运行。" >&2
        echo "运行命令: ${LOCAL_AGENT_DOWNLOAD_PATH} start --server \"${SERVER_URL}\" --token \"${AGENT_TOKEN}\" --collect-interval \"${AGENT_COLLECT_INTERVAL}\" --report-interval \"${AGENT_REPORT_INTERVAL}\""
        exit 1
    fi

    echo "将 Agent 移动到 ${AGENT_INSTALL_PATH}..."
    ${SUDO_CMD} mv "${LOCAL_AGENT_DOWNLOAD_PATH}" "${AGENT_INSTALL_PATH}"
    if [ $? -ne 0 ]; then
        echo "错误: 移动 Agent 到 ${AGENT_INSTALL_PATH} 失败。请检查权限。" >&2
        exit 1
    fi

    echo "创建 systemd 服务文件: ${SERVICE_FILE_PATH}..."
    SERVICE_FILE_CONTENT="[Unit]
Description=${AGENT_NAME}
After=network.target

[Service]
Type=simple
ExecStart=${AGENT_INSTALL_PATH} start --server \"${SERVER_URL}\" --token \"${AGENT_TOKEN}\" --collect-interval \"${AGENT_COLLECT_INTERVAL}\" --report-interval \"${AGENT_REPORT_INTERVAL}\"
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment="HOME=/root"
# 考虑为更佳安全性设置 User= 和 Group= (例如创建一个 'xugou' 用户)
# User=nobody
# Group=nogroup

[Install]
WantedBy=multi-user.target"

    # Use a temporary file to write content then sudo tee to destination
    TEMP_SERVICE_FILE=$(mktemp)
    echo "${SERVICE_FILE_CONTENT}" > "${TEMP_SERVICE_FILE}"
    ${SUDO_CMD} mkdir -p "$(dirname "${SERVICE_FILE_PATH}")" # Ensure /etc/systemd/system exists
    ${SUDO_CMD} cp "${TEMP_SERVICE_FILE}" "${SERVICE_FILE_PATH}"
    rm "${TEMP_SERVICE_FILE}"
    ${SUDO_CMD} chmod 644 "${SERVICE_FILE_PATH}"


    echo "重新加载 systemd 管理器配置..."
    ${SUDO_CMD} systemctl daemon-reload
    echo "启用 ${SERVICE_NAME} 服务 (开机自启)..."
    ${SUDO_CMD} systemctl enable "${SERVICE_NAME}"
    echo "启动 ${SERVICE_NAME} 服务..."
    ${SUDO_CMD} systemctl start "${SERVICE_NAME}"
    echo ""
    echo "${AGENT_NAME} 已作为 systemd 服务安装并启动。"
    echo "您可以使用以下命令检查服务状态:"
    echo "  sudo systemctl status ${SERVICE_NAME}"
    echo "查看日志:"
    echo "  sudo journalctl -u ${SERVICE_NAME} -f"
    print_builtin_commands "${AGENT_NAME}" "sudo"
  else
    echo "Agent 已下载到 ${LOCAL_AGENT_DOWNLOAD_PATH}"
    if [ "$PLATFORM" = "darwin" ]; then
        echo "在 macOS 上, 您可以这样运行 Agent:"
        echo "  ${LOCAL_AGENT_DOWNLOAD_PATH} start --server \"${SERVER_URL}\" --token \"${AGENT_TOKEN}\" --collect-interval \"${AGENT_COLLECT_INTERVAL}\" --report-interval \"${AGENT_REPORT_INTERVAL}\""
        echo "要在后台运行, 可以使用 nohup:"
        echo "  nohup ${LOCAL_AGENT_DOWNLOAD_PATH} start --server \"${SERVER_URL}\" --token \"${AGENT_TOKEN}\" --collect-interval \"${AGENT_COLLECT_INTERVAL}\" --report-interval \"${AGENT_REPORT_INTERVAL}\" > xugou-agent.log 2>&1 &"
        echo "或者考虑使用 launchd 创建一个持久化服务。"
    else # Generic Linux without systemd or other OS
        echo "您可以这样运行 Agent:"
        echo "  ${LOCAL_AGENT_DOWNLOAD_PATH} start --server \"${SERVER_URL}\" --token \"${AGENT_TOKEN}\" --collect-interval \"${AGENT_COLLECT_INTERVAL}\" --report-interval \"${AGENT_REPORT_INTERVAL}\""
    fi
    print_builtin_commands "${LOCAL_AGENT_DOWNLOAD_PATH}" ""
  fi
  echo "安装完成。"
  set_env_vars
}

# --- 内置命令委托 ---
# 查找已安装的 agent 二进制：优先系统安装路径，其次当前目录，最后 PATH
find_installed_agent() {
  if [ -x "${AGENT_INSTALL_PATH}" ]; then
    echo "${AGENT_INSTALL_PATH}"
  elif [ -x "./${AGENT_NAME}${EXTENSION}" ]; then
    echo "./${AGENT_NAME}${EXTENSION}"
  else
    command -v "${AGENT_NAME}" 2>/dev/null || true
  fi
}

# 探测二进制是否支持内置子命令（旧版二进制对未知子命令的 --help 会报错退出）
# $1: 二进制路径  $2: 子命令名
agent_supports_command() {
  "$1" "$2" --help >/dev/null 2>&1
}

# 若已安装的二进制内置了指定子命令，则直接 exec 委托执行（不再返回）
# $1: 子命令名  其余参数原样传给子命令
try_delegate_to_agent() {
  local subcmd="$1"
  shift
  local bin
  bin=$(find_installed_agent)
  if [ -n "$bin" ] && agent_supports_command "$bin" "$subcmd"; then
    echo "检测到 Agent 已内置 ${subcmd} 命令，委托执行: ${bin} ${subcmd} $*"
    if [ "$bin" = "${AGENT_INSTALL_PATH}" ] && [ -n "$SUDO_CMD" ]; then
      exec ${SUDO_CMD} "$bin" "$subcmd" "$@"
    fi
    exec "$bin" "$subcmd" "$@"
  fi
  echo "未检测到内置 ${subcmd} 命令（旧版二进制或未安装），使用脚本内置流程继续。"
}

# --- 更新 Agent ---
do_update() {
  detect_os_arch

  # 新版二进制内置自升级命令，优先委托；旧版二进制回退到下方 shell 流程
  try_delegate_to_agent update

  read_env_vars
  if [ -z "$XUGOU_SERVER" ] || [ -z "$XUGOU_TOKEN" ]; then
    echo "错误: 未检测到 XUGOU_SERVER 或 XUGOU_TOKEN 环境变量，请先运行 install 命令。" >&2
    exit 1
  fi

  echo "开始更新 ${AGENT_NAME}..."
  echo "服务器地址: ${XUGOU_SERVER}"
  echo "Agent 令牌: **** (已隐藏)"

  if [ "$PLATFORM" = "linux" ] && command -v systemctl &> /dev/null; then
    if ${SUDO_CMD} systemctl list-unit-files | grep -q "${SERVICE_NAME}"; then
      echo "停止 ${SERVICE_NAME} 服务..."
      ${SUDO_CMD} systemctl stop "${SERVICE_NAME}" || true
    fi
  fi

  if [ -f "${AGENT_INSTALL_PATH}" ]; then
    echo "删除旧版 Agent: ${AGENT_INSTALL_PATH}"
    ${SUDO_CMD} rm -f "${AGENT_INSTALL_PATH}"
  fi
  LOCAL_AGENT_DOWNLOAD_PATH="./${AGENT_NAME}${EXTENSION}"
  if [ -f "${LOCAL_AGENT_DOWNLOAD_PATH}" ]; then
    echo "删除本地旧版 Agent: ${LOCAL_AGENT_DOWNLOAD_PATH}"
    rm -f "${LOCAL_AGENT_DOWNLOAD_PATH}"
  fi

  DOWNLOAD_URL="${DOWNLOAD_BASE_URL}/${AGENT_NAME}-${PLATFORM}-${ARCH}${EXTENSION}"
  echo "下载最新 Agent: ${DOWNLOAD_URL}"
  if command -v curl >/dev/null 2>&1; then
    curl -sSL "${DOWNLOAD_URL}" -o "${LOCAL_AGENT_DOWNLOAD_PATH}"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "${LOCAL_AGENT_DOWNLOAD_PATH}" "${DOWNLOAD_URL}"
  else
    echo "错误: 系统中未找到 curl 或 wget。请先安装其中一个。" >&2
    exit 1
  fi
  chmod +x "${LOCAL_AGENT_DOWNLOAD_PATH}"

  if [ "$PLATFORM" = "linux" ] && command -v systemctl &> /dev/null; then
    echo "将 Agent 移动到 ${AGENT_INSTALL_PATH}..."
    ${SUDO_CMD} mv "${LOCAL_AGENT_DOWNLOAD_PATH}" "${AGENT_INSTALL_PATH}"

    SERVICE_FILE_CONTENT="[Unit]
Description=${AGENT_NAME}
After=network.target

[Service]
Type=simple
ExecStart=${AGENT_INSTALL_PATH} start --server \"${XUGOU_SERVER}\" --token \"${XUGOU_TOKEN}\" --collect-interval \"${AGENT_COLLECT_INTERVAL}\" --report-interval \"${AGENT_REPORT_INTERVAL}\"
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=\"HOME=/root\"
# 考虑为更佳安全性设置 User= 和 Group= (例如创建一个 'xugou' 用户)
# User=nobody
# Group=nogroup

[Install]
WantedBy=multi-user.target"
    TEMP_SERVICE_FILE=$(mktemp)
    echo "${SERVICE_FILE_CONTENT}" > "${TEMP_SERVICE_FILE}"
    ${SUDO_CMD} mkdir -p "$(dirname "${SERVICE_FILE_PATH}")"
    ${SUDO_CMD} cp "${TEMP_SERVICE_FILE}" "${SERVICE_FILE_PATH}"
    rm "${TEMP_SERVICE_FILE}"
    ${SUDO_CMD} chmod 644 "${SERVICE_FILE_PATH}"
    ${SUDO_CMD} systemctl daemon-reload
    ${SUDO_CMD} systemctl enable "${SERVICE_NAME}"
    ${SUDO_CMD} systemctl restart "${SERVICE_NAME}"
    echo "${AGENT_NAME} 已更新并重启 systemd 服务。"
  else
    echo "Agent 已下载到 ${LOCAL_AGENT_DOWNLOAD_PATH}"
    echo "使用如下命令启动 Agent："
    echo "  ${LOCAL_AGENT_DOWNLOAD_PATH} start --server \"${XUGOU_SERVER}\" --token \"${XUGOU_TOKEN}\" --collect-interval \"${AGENT_COLLECT_INTERVAL}\" --report-interval \"${AGENT_REPORT_INTERVAL}\""
  fi
  echo "更新完成。"
}

# --- 卸载 Agent ---
do_uninstall() {
  detect_os_arch # Needed to know if we are on Linux for service removal

  # 新版二进制内置自卸载命令，优先委托；旧版二进制回退到下方 shell 流程
  try_delegate_to_agent uninstall --yes

  echo "开始卸载 ${AGENT_NAME}..."

  if [ "$PLATFORM" = "linux" ] && command -v systemctl &> /dev/null; then
    echo "检测到 Linux 系统并支持 systemd。将尝试移除服务..."
    if [ -z "$SUDO_CMD" ] && [[ $EUID -ne 0 ]]; then
        echo "警告: 需要 sudo 权限来移除 systemd 服务，但 sudo 命令未找到或您不是 root 用户。" >&2
        echo "将仅尝试删除本地文件 (如果存在于当前目录)。" >&2
    else
        if ${SUDO_CMD} systemctl list-unit-files | grep -q "${SERVICE_NAME}"; then
            echo "停止 ${SERVICE_NAME} 服务..."
            ${SUDO_CMD} systemctl stop "${SERVICE_NAME}" || echo "服务可能未在运行。"
            echo "禁用 ${SERVICE_NAME} 服务 (取消开机自启)..."
            ${SUDO_CMD} systemctl disable "${SERVICE_NAME}" || echo "服务可能未启用。"
            echo "删除 systemd 服务文件: ${SERVICE_FILE_PATH}..."
            ${SUDO_CMD} rm -f "${SERVICE_FILE_PATH}"
            echo "重新加载 systemd 管理器配置..."
            ${SUDO_CMD} systemctl daemon-reload
            echo "systemd 服务相关内容已移除。"
        else
            echo "${SERVICE_NAME} 服务未找到或未注册。"
        fi

        if [ -f "${AGENT_INSTALL_PATH}" ]; then
            echo "删除 Agent 二进制文件: ${AGENT_INSTALL_PATH}..."
            ${SUDO_CMD} rm -f "${AGENT_INSTALL_PATH}"
        else
            echo "Agent 二进制文件 ${AGENT_INSTALL_PATH} 未找到。"
        fi
    fi
  elif [ "$PLATFORM" = "darwin" ]; then
    echo "在 macOS 上, 请手动卸载:"
    echo "1. 找到并终止正在运行的 ${AGENT_NAME} 进程 (例如使用 'pkill ${AGENT_NAME}' 或 活动监视器)."
    echo "2. 删除 ${AGENT_NAME} 二进制文件 (通常在您下载或运行它的目录中)."
    echo "3. 如果您配置了 launchd 服务, 请手动移除它。"
  elif [ "$PLATFORM" = "windows" ]; then
    echo "在 Windows 上, 请手动卸载:"
    echo "1. 找到并终止正在运行的 ${AGENT_NAME}${EXTENSION} 进程 (例如使用 任务管理器)."
    echo "2. 删除 ${AGENT_NAME}${EXTENSION} 可执行文件。"
  else
    echo "卸载步骤取决于您的安装方式。"
  fi

  # Attempt to remove local agent file if it exists (e.g. from a non-service install)
  LOCAL_AGENT_DOWNLOAD_PATH="./${AGENT_NAME}${EXTENSION}"
  if [ -f "${LOCAL_AGENT_DOWNLOAD_PATH}" ]; then
      echo "删除本地 Agent 文件 (如果存在): ${LOCAL_AGENT_DOWNLOAD_PATH}..."
      rm -f "${LOCAL_AGENT_DOWNLOAD_PATH}"
  fi

  echo "卸载过程完成。"
}

# --- 主逻辑 ---
SUBCOMMAND="install" # Default subcommand

# Check for subcommand as the first argument
if [[ "$1" == "install" || "$1" == "uninstall" || "$1" == "help" || "$1" == "update" ]]; then
  SUBCOMMAND="$1"
  shift
elif [[ "$1" == -* ]]; then # If first arg is an option, assume 'install'
  SUBCOMMAND="install"
else # If first arg is not a known command or an option, show usage
  if [ -n "$1" ]; then # If there's an argument but it's not recognized
    echo "错误: 未知命令或参数 '$1'" >&2
  fi
  print_usage
fi

# Parse options based on subcommand
if [[ "$SUBCOMMAND" == "install" ]]; then
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --server)
        SERVER_URL="$2"
        shift 2
        ;;
      --token)
        AGENT_TOKEN="$2"
        shift 2
        ;;
      --collect-interval)
        AGENT_COLLECT_INTERVAL="$2"
        shift 2
        ;;
      --report-interval)
        AGENT_REPORT_INTERVAL="$2"
        shift 2
        ;;
      --interval)
        # 兼容旧安装命令：旧参数现在只调整 HTTP 批量周期，秒级采集保持开启。
        AGENT_REPORT_INTERVAL="$2"
        shift 2
        ;;
      -h|--help) # Allow --help after 'install' subcommand too
        print_usage
        ;;
      *)
        echo "错误: 'install' 命令的未知参数: $1" >&2
        print_usage
        ;;
    esac
  done
fi

# Execute command
case "$SUBCOMMAND" in
  install)
    do_install
    ;;
  update)
    do_update
    ;;
  uninstall)
    do_uninstall
    ;;
  help)
    print_usage
    ;;
  *) # Should have been caught earlier, but as a fallback
    echo "错误: 未知子命令 '$SUBCOMMAND'" >&2
    print_usage
    ;;
esac

exit 0