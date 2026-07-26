package agent

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"

	"github.com/spf13/cobra"
	"github.com/xugou/agent/pkg/selfmgmt"
)

func init() {
	var (
		updateURL string
		checkOnly bool
		force     bool
	)

	updateCmd := &cobra.Command{
		Use:   "update",
		Short: "升级 Xugou Agent 到最新版本",
		Long: `从官方分发地址下载最新版本，并原地原子替换当前可执行文件。

默认下载地址: ` + selfmgmt.DefaultDownloadBase + `/` + selfmgmt.BinaryName(runtime.GOOS, runtime.GOARCH) + `
（官方分发仅提供 latest 通道，不支持指定历史版本）

行为说明:
  - 下载后会校验文件非空且为合法可执行文件（ELF/Mach-O 魔数）；
  - 升级完成后，若检测到 systemd 服务 xugou-agent 正在运行，会尝试自动重启；
  - Windows 平台不支持运行中自替换，请手动下载并替换可执行文件。

示例:
  xugou-agent update            升级到最新版本
  xugou-agent update --check    仅检查远端版本，不执行升级
  xugou-agent update --url http://my-mirror/xugou-agent-linux-amd64   使用自建分发地址`,
		SilenceUsage:  true,
		SilenceErrors: true, // main 函数会统一打印错误，避免重复输出
		RunE: func(cmd *cobra.Command, args []string) error {
			return runUpdate(updateURL, checkOnly, force)
		},
	}
	updateCmd.Flags().StringVar(&updateURL, "url", "", "自定义二进制下载地址（覆盖官方分发地址）")
	updateCmd.Flags().BoolVar(&checkOnly, "check", false, "仅检查远端版本，不执行升级")
	updateCmd.Flags().BoolVar(&force, "force", false, "远端版本与本地相同时也强制替换")
	rootCmd.AddCommand(updateCmd)
}

// updateLogger 升级流程的日志输出函数（CLI 走 fmt.Printf，远程触发走 log.Printf）
type updateLogger func(format string, args ...any)

func runUpdate(rawURL string, checkOnly, force bool) error {
	printf := func(format string, args ...any) {
		fmt.Printf(format+"\n", args...)
	}

	if runtime.GOOS == "windows" {
		fmt.Println("Windows 平台暂不支持原地自升级。")
		fmt.Println("请手动下载新版本并替换当前可执行文件:")
		fmt.Printf("  %s\n", selfmgmt.DownloadURL(selfmgmt.DefaultDownloadBase, runtime.GOOS, runtime.GOARCH))
		return nil
	}

	downloadURL := rawURL
	if downloadURL == "" {
		downloadURL = selfmgmt.DownloadURL(selfmgmt.DefaultDownloadBase, runtime.GOOS, runtime.GOARCH)
	}

	if !checkOnly {
		return doSelfUpdate(downloadURL, force, printf)
	}

	// --check：只下载到系统临时目录做版本预检，不替换
	exePath, err := selfmgmt.ResolveExecutable()
	if err != nil {
		return fmt.Errorf("无法确定当前可执行文件路径: %w", err)
	}
	fmt.Printf("当前版本: %s\n", Version)
	fmt.Printf("可执行文件: %s\n", exePath)
	fmt.Printf("下载地址: %s\n", downloadURL)

	fmt.Println("正在下载...")
	tmpPath, err := selfmgmt.DownloadToFile(downloadURL, os.TempDir())
	if err != nil {
		return err
	}
	defer os.Remove(tmpPath)

	if err := selfmgmt.ValidateBinaryFile(tmpPath); err != nil {
		return fmt.Errorf("下载文件校验失败: %w", err)
	}
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		return fmt.Errorf("设置可执行权限失败: %w", err)
	}

	remoteVersion, verErr := selfmgmt.BinaryVersion(tmpPath)
	if verErr != nil {
		fmt.Printf("警告: 无法获取远端版本号（%v），跳过版本对比\n", verErr)
	} else {
		fmt.Printf("远端版本: %s\n", remoteVersion)
	}
	return reportVersionCheck(remoteVersion, verErr)
}

// doSelfUpdate 下载→魔数校验→版本对比→原子替换→按需重启服务的核心流程，
// update 命令与服务端远程触发（update=1）共用。
func doSelfUpdate(downloadURL string, force bool, logf updateLogger) error {
	if runtime.GOOS == "windows" {
		logf("Windows 平台暂不支持原地自升级，请手动下载替换: %s",
			selfmgmt.DownloadURL(selfmgmt.DefaultDownloadBase, runtime.GOOS, runtime.GOARCH))
		return nil
	}

	exePath, err := selfmgmt.ResolveExecutable()
	if err != nil {
		return fmt.Errorf("无法确定当前可执行文件路径: %w", err)
	}

	logf("当前版本: %s", Version)
	logf("可执行文件: %s", exePath)
	logf("下载地址: %s", downloadURL)

	// 下载到目标同目录，保证 rename 原子性
	destDir := filepath.Dir(exePath)
	logf("正在下载...")
	tmpPath, err := selfmgmt.DownloadToFile(downloadURL, destDir)
	if err != nil {
		if !selfmgmt.IsRoot() && errors.Is(err, os.ErrPermission) {
			logf("提示: 无法写入 %s，请尝试: sudo %s update", destDir, selfmgmt.AgentName)
		}
		return err
	}
	defer os.Remove(tmpPath)

	if err := selfmgmt.ValidateBinaryFile(tmpPath); err != nil {
		return fmt.Errorf("下载文件校验失败: %w", err)
	}
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		return fmt.Errorf("设置可执行权限失败: %w", err)
	}

	// 分发端未提供版本接口/sha256 文件，通过执行下载的二进制获取远端版本
	remoteVersion, verErr := selfmgmt.BinaryVersion(tmpPath)
	if verErr != nil {
		logf("警告: 无法获取远端版本号（%v），跳过版本对比", verErr)
	} else {
		logf("远端版本: %s", remoteVersion)
	}

	if !force && verErr == nil && remoteVersion == Version {
		logf("已是最新版本 (%s)，无需升级。如需强制替换请使用 --force。", Version)
		return nil
	}

	if err := selfmgmt.ReplaceExecutable(tmpPath, exePath); err != nil {
		if !selfmgmt.IsRoot() {
			logf("提示: 若为权限不足，请尝试: sudo %s update", selfmgmt.AgentName)
		}
		return err
	}
	if verErr == nil {
		logf("升级完成: %s (%s -> %s)", exePath, Version, remoteVersion)
	} else {
		logf("升级完成: %s", exePath)
	}

	restartServiceAfterUpdate(logf)
	return nil
}

// reportVersionCheck 输出 --check 的对比结论
func reportVersionCheck(remoteVersion string, verErr error) error {
	if verErr != nil {
		fmt.Println("无法预检远端版本，请直接执行 xugou-agent update 进行升级。")
		return nil
	}
	if remoteVersion == Version {
		fmt.Printf("已是最新版本 (%s)。\n", Version)
		return nil
	}
	if result, ok := selfmgmt.CompareVersions(Version, remoteVersion); ok && result > 0 {
		fmt.Printf("本地版本 (%s) 高于远端版本 (%s)，无需升级。\n", Version, remoteVersion)
		return nil
	}
	fmt.Printf("发现新版本: %s -> %s，执行 xugou-agent update 进行升级。\n", Version, remoteVersion)
	return nil
}

// restartServiceAfterUpdate 升级后尽力重启 systemd 服务，失败时输出手动命令
func restartServiceAfterUpdate(logf updateLogger) {
	state := selfmgmt.ServiceState()
	if !state.Available {
		logf("提示: 未检测到 systemd 环境，如 Agent 正在运行请手动重启以加载新版本。")
		return
	}
	if !state.Active {
		if state.UnitExists {
			logf("提示: systemd 服务 %s 当前未运行，如需启动: sudo systemctl start %s",
				selfmgmt.ServiceName, selfmgmt.ServiceName)
		} else {
			logf("提示: 未检测到 systemd 服务，如 Agent 正在运行请手动重启以加载新版本。")
		}
		return
	}

	logf("检测到 systemd 服务 %s 正在运行，尝试重启...", selfmgmt.ServiceName)
	if err := selfmgmt.Systemctl("restart", selfmgmt.ServiceName); err != nil {
		logf("自动重启失败: %v", err)
		logf("请手动执行: sudo systemctl restart %s", selfmgmt.ServiceName)
		return
	}
	logf("服务已重启，新版本已生效。")
}

// remoteUpdateInProgress 远程触发自升级的互斥标记：升级进行中时忽略新指令，防重入
var remoteUpdateInProgress atomic.Bool

// TriggerRemoteUpdate 服务端下发 update=1 时异步触发自升级：
// 复用 update 命令的核心流程（下载/校验/替换/按需重启 systemd 服务）。
// 升级失败只记日志，不影响采集与上报；指令不落配置文件。
// 下载地址可用环境变量 XUGOU_UPDATE_URL 覆盖（自建分发/本地验证用）。
func TriggerRemoteUpdate() {
	if !remoteUpdateInProgress.CompareAndSwap(false, true) {
		log.Println("收到服务端升级指令，但已有升级流程在进行，忽略本次触发")
		return
	}

	go func() {
		defer remoteUpdateInProgress.Store(false)

		downloadURL := os.Getenv("XUGOU_UPDATE_URL")
		if downloadURL == "" {
			downloadURL = selfmgmt.DownloadURL(selfmgmt.DefaultDownloadBase, runtime.GOOS, runtime.GOARCH)
		}
		log.Printf("收到服务端升级指令，开始自升级: %s", downloadURL)
		if err := doSelfUpdate(downloadURL, false, log.Printf); err != nil {
			log.Printf("远程触发升级失败（不影响采集上报）: %v", err)
			return
		}
		log.Println("远程触发升级流程结束")
	}()
}
