package selfmgmt

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"
)

// downloadTimeout 单次下载的总超时时间
const downloadTimeout = 5 * time.Minute

// DownloadToFile 将 url 指向的文件下载到 dir 目录下的临时文件，返回临时文件路径。
// 调用方负责在使用完毕后删除该文件（原子替换成功后该文件已被 rename，删除会静默失败）。
func DownloadToFile(rawURL, dir string) (string, error) {
	client := &http.Client{Timeout: downloadTimeout}
	resp, err := client.Get(rawURL)
	if err != nil {
		return "", fmt.Errorf("下载失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("下载失败: 服务器返回 %s", resp.Status)
	}

	tmp, err := os.CreateTemp(dir, ".xugou-agent-download-*")
	if err != nil {
		return "", fmt.Errorf("创建临时文件失败: %w", err)
	}
	tmpPath := tmp.Name()

	if _, err := io.Copy(tmp, resp.Body); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return "", fmt.Errorf("写入临时文件失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return "", fmt.Errorf("关闭临时文件失败: %w", err)
	}
	return tmpPath, nil
}

// ValidateBinaryFile 校验下载的文件是否像一个可执行文件（魔数校验）。
// 注：分发端未提供 sha256 校验文件，此处只能做基础完整性校验。
func ValidateBinaryFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("打开文件失败: %w", err)
	}
	defer f.Close()

	header := make([]byte, 4)
	if _, err := io.ReadFull(f, header); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return errors.New("文件过短（不足 4 字节），不是有效的可执行文件")
		}
		return fmt.Errorf("读取文件头失败: %w", err)
	}
	return CheckBinaryMagic(header)
}

// ReplaceExecutable 用 newPath 原子替换 target 可执行文件。
// 两个路径必须位于同一目录（同一文件系统），采用两步 rename：
// target -> target.old，newPath -> target，成功后删除 target.old。
// Linux/macOS 允许 rename/unlink 正在运行的二进制，因此可在运行中自替换。
func ReplaceExecutable(newPath, target string) error {
	if err := os.Chmod(newPath, 0o755); err != nil {
		return fmt.Errorf("设置可执行权限失败: %w", err)
	}

	backup := target + ".old"
	_ = os.Remove(backup)
	if err := os.Rename(target, backup); err != nil {
		return fmt.Errorf("备份旧版本失败（可能需要 sudo 权限）: %w", err)
	}
	if err := os.Rename(newPath, target); err != nil {
		// 回滚，尽量保持原状
		_ = os.Rename(backup, target)
		return fmt.Errorf("替换可执行文件失败: %w", err)
	}
	_ = os.Remove(backup)
	return nil
}

// BinaryVersion 获取二进制的版本号，用于升级前后的版本对比。
// 优先执行 `<path> version --short` 取机器可读的裸版本号（对输出格式不敏感），
// 旧二进制不支持该 flag 时回退到解析 `<path> version` 的人类可读输出。
// 执行失败或解析不到版本号时返回空串与错误。
func BinaryVersion(path string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if out, err := exec.CommandContext(ctx, path, "version", "--short").Output(); err == nil {
		if v := lastNonEmptyLine(string(out)); v != "" && !strings.ContainsAny(v, " \t") {
			return v, nil
		}
	}

	out, err := exec.CommandContext(ctx, path, "version").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("执行 %s version 失败: %w", path, err)
	}
	v := ParseVersionOutput(string(out))
	if v == "" {
		return "", fmt.Errorf("无法从输出中解析版本号")
	}
	return v, nil
}

// lastNonEmptyLine 返回输出中最后一个非空行（容忍版本号前混入的日志行，
// 例如 initConfig 打印的 "使用配置文件: ..."）
func lastNonEmptyLine(output string) string {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for _, raw := range slices.Backward(lines) {
		if line := strings.TrimSpace(raw); line != "" {
			return line
		}
	}
	return ""
}

// ResolveExecutable 返回当前可执行文件的真实路径（尽力解析符号链接）
func ResolveExecutable() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exePath); err == nil {
		exePath = resolved
	}
	return exePath, nil
}

// HasSystemctl 检测当前系统是否存在 systemctl 命令
func HasSystemctl() bool {
	_, err := exec.LookPath("systemctl")
	return err == nil
}

// SystemdServiceState 汇总 xugou-agent systemd 服务的三态判断，
// 供 status/update/uninstall 三个命令统一渲染。
type SystemdServiceState struct {
	Available  bool // Linux 且检测到 systemctl
	UnitExists bool // 服务单元文件存在
	Active     bool // systemctl is-active 为运行中
}

// Installed 服务是否已安装：单元文件存在，或服务正在运行（单元文件被手工挪走等场景）
func (s SystemdServiceState) Installed() bool {
	return s.UnitExists || s.Active
}

// ServiceState 探测当前 systemd 服务状态；非 Linux 或无 systemctl 时各项均为 false
func ServiceState() SystemdServiceState {
	if runtime.GOOS != "linux" || !HasSystemctl() {
		return SystemdServiceState{}
	}
	return SystemdServiceState{
		Available:  true,
		UnitExists: ServiceUnitExists(),
		Active:     ServiceActive(ServiceName),
	}
}

// ServiceUnitExists 检测 systemd 服务单元文件是否存在
func ServiceUnitExists() bool {
	_, err := os.Stat(ServiceUnitPath)
	return err == nil
}

// ServiceActive 检测 systemd 服务是否处于运行状态
func ServiceActive(name string) bool {
	return exec.Command("systemctl", "is-active", "--quiet", name).Run() == nil
}

// SystemctlOutput 执行 systemctl 命令并返回去除首尾空白的合并输出（忽略错误，用于状态展示）
func SystemctlOutput(args ...string) string {
	out, _ := exec.Command("systemctl", args...).CombinedOutput()
	return strings.TrimSpace(string(out))
}

// Systemctl 执行 systemctl 命令，失败时返回带输出内容的错误
func Systemctl(args ...string) error {
	out, err := exec.Command("systemctl", args...).CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			return fmt.Errorf("systemctl %s 失败: %w", strings.Join(args, " "), err)
		}
		return fmt.Errorf("systemctl %s 失败: %s", strings.Join(args, " "), msg)
	}
	return nil
}

// IsRoot 当前进程是否以 root 身份运行（Windows 上恒为 false）
func IsRoot() bool {
	return os.Geteuid() == 0
}
