package selfmgmt

import (
	"context"
	"errors"
	"fmt"
	"io"
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

// ReplaceExecutableWithHealthCheck 保留上一版本，原子替换后执行新二进制的
// 机器可读版本命令作为启动健康检查；检查失败会立刻恢复旧二进制。
func ReplaceExecutableWithHealthCheck(newPath, target, expectedVersion string) error {
	return replaceExecutableWithHealthCheck(newPath, target, expectedVersion, BinaryVersion)
}

func replaceExecutableWithHealthCheck(
	newPath, target, expectedVersion string,
	versionProbe func(string) (string, error),
) error {
	if err := os.Chmod(newPath, 0o755); err != nil {
		return fmt.Errorf("设置可执行权限失败: %w", err)
	}
	newFile, err := os.Open(newPath)
	if err != nil {
		return fmt.Errorf("打开新版本失败: %w", err)
	}
	if err := newFile.Sync(); err != nil {
		newFile.Close()
		return fmt.Errorf("同步新版本失败: %w", err)
	}
	if err := newFile.Close(); err != nil {
		return fmt.Errorf("关闭新版本失败: %w", err)
	}

	directory := filepath.Dir(target)
	backup := target + ".old"
	if err := installExecutable(newPath, target, backup); err != nil {
		return fmt.Errorf("原子替换可执行文件失败: %w", err)
	}
	rollback := func(cause error) error {
		if restoreErr := restoreExecutable(target, backup); restoreErr != nil {
			return fmt.Errorf("%v；恢复旧版本失败: %w", cause, restoreErr)
		}
		_ = syncDirectory(directory)
		return fmt.Errorf("新版本启动健康检查失败，已恢复旧版本: %w", cause)
	}
	if err := syncDirectory(directory); err != nil {
		return rollback(fmt.Errorf("同步可执行文件目录失败: %w", err))
	}
	actualVersion, err := versionProbe(target)
	if err != nil {
		return rollback(err)
	}
	if comparison, ok := CompareVersions(actualVersion, expectedVersion); !ok || comparison != 0 {
		return rollback(fmt.Errorf(
			"新版本号与签名清单不一致: got=%s want=%s",
			actualVersion,
			expectedVersion,
		))
	}
	if err := os.Remove(backup); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("新版本已生效，但清理旧版本备份失败: %w", err)
	}
	if err := syncDirectory(directory); err != nil {
		return fmt.Errorf("新版本已生效，但同步目录失败: %w", err)
	}
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
