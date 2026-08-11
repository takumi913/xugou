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

默认签名清单: ` + selfmgmt.DefaultManifestURL + `

行为说明:
  - 先使用内置 Ed25519 公钥验证清单签名；
  - 严格校验平台、版本、文件大小和 SHA-256，再校验可执行文件格式；
  - 同目录 fsync + 原子替换；新二进制启动健康检查失败时自动恢复旧版本；
	  - 升级完成后自动恢复 systemd/Windows Service 或控制台 Agent；
	  - Windows 使用独立 helper 等待旧进程退出，探活失败自动回滚。

示例:
  xugou-agent update            升级到最新版本
  xugou-agent update --check    仅检查远端版本，不执行升级
  xugou-agent update --url https://mirror.example/manifest.json   使用自建签名清单`,
		SilenceUsage:  true,
		SilenceErrors: true, // main 函数会统一打印错误，避免重复输出
		RunE: func(cmd *cobra.Command, args []string) error {
			return runUpdate(updateURL, checkOnly, force)
		},
	}
	updateCmd.Flags().StringVar(&updateURL, "url", "", "自定义签名 manifest.json 地址")
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

	manifestURL := rawURL
	if manifestURL == "" {
		manifestURL = selfmgmt.DefaultManifestURL
	}

	if !checkOnly {
		err := doSelfUpdate(manifestURL, force, printf)
		if errors.Is(err, selfmgmt.ErrUpdateScheduled) {
			fmt.Println("Windows 替换 helper 已启动，当前进程即将退出。")
			return nil
		}
		return err
	}

	// --check：只下载并验证签名清单，不下载或执行远端二进制。
	exePath, err := selfmgmt.ResolveExecutable()
	if err != nil {
		return fmt.Errorf("无法确定当前可执行文件路径: %w", err)
	}
	fmt.Printf("当前版本: %s\n", Version)
	fmt.Printf("可执行文件: %s\n", exePath)
	fmt.Printf("签名清单: %s\n", selfmgmt.ManifestURL(manifestURL))

	fmt.Println("正在验证发布清单...")
	release, err := selfmgmt.FetchVerifiedRelease(
		manifestURL,
		UpdatePublicKey,
		runtime.GOOS,
		runtime.GOARCH,
	)
	if err != nil {
		return err
	}
	fmt.Printf("远端版本: %s\n", release.Manifest.Version)
	fmt.Printf("产物: %s/%s (%d bytes)\n",
		release.Artifact.OS,
		release.Artifact.Arch,
		release.Artifact.Size,
	)
	return reportVersionCheck(release.Manifest.Version, nil)
}

// doSelfUpdate 签名清单→哈希/大小校验→健康检查原子替换→按需重启服务，
// update 命令与服务端远程触发（update=1）共用。
func doSelfUpdate(manifestURL string, force bool, logf updateLogger) error {
	exePath, err := selfmgmt.ResolveExecutable()
	if err != nil {
		return fmt.Errorf("无法确定当前可执行文件路径: %w", err)
	}

	logf("当前版本: %s", Version)
	logf("可执行文件: %s", exePath)
	logf("签名清单: %s", selfmgmt.ManifestURL(manifestURL))

	logf("正在验证发布清单...")
	release, err := selfmgmt.FetchVerifiedRelease(
		manifestURL,
		UpdatePublicKey,
		runtime.GOOS,
		runtime.GOARCH,
	)
	if err != nil {
		return err
	}
	remoteVersion := release.Manifest.Version
	logf("已验证远端版本: %s", remoteVersion)
	if !force {
		if comparison, ok := selfmgmt.CompareVersions(Version, remoteVersion); ok && comparison >= 0 {
			logf("当前版本 (%s) 不低于签名版本 (%s)，无需升级。", Version, remoteVersion)
			return nil
		}
	}

	// 下载到目标同目录，保证 rename 原子性
	destDir := filepath.Dir(exePath)
	logf("正在下载并校验产物...")
	tmpPath, err := selfmgmt.DownloadVerifiedArtifact(release, destDir)
	if err != nil {
		if !selfmgmt.IsRoot() && errors.Is(err, os.ErrPermission) {
			logf("提示: 无法写入 %s，请尝试: sudo %s update", destDir, selfmgmt.AgentName)
		}
		return err
	}
	defer os.Remove(tmpPath)

	if err := os.Chmod(tmpPath, 0o755); err != nil {
		return fmt.Errorf("设置可执行权限失败: %w", err)
	}
	if runtime.GOOS == "windows" {
		logf("已验证升级包，正在启动 Windows 替换 helper...")
		return selfmgmt.LaunchWindowsUpdateHelper(tmpPath, exePath, remoteVersion)
	}

	if err := selfmgmt.ReplaceExecutableWithHealthCheck(
		tmpPath,
		exePath,
		remoteVersion,
	); err != nil {
		if !selfmgmt.IsRoot() {
			logf("提示: 若为权限不足，请尝试: sudo %s update", selfmgmt.AgentName)
		}
		return err
	}
	logf("升级完成: %s (%s -> %s)", exePath, Version, remoteVersion)

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
// 签名清单可用环境变量 XUGOU_UPDATE_MANIFEST_URL 覆盖。
func TriggerRemoteUpdate() {
	if !remoteUpdateInProgress.CompareAndSwap(false, true) {
		log.Println("收到服务端升级指令，但已有升级流程在进行，忽略本次触发")
		return
	}

	go func() {
		defer remoteUpdateInProgress.Store(false)

		manifestURL := os.Getenv("XUGOU_UPDATE_MANIFEST_URL")
		if manifestURL == "" {
			manifestURL = selfmgmt.DefaultManifestURL
		}
		log.Printf("收到服务端升级指令，开始验证签名清单: %s", manifestURL)
		if err := doSelfUpdate(manifestURL, false, log.Printf); err != nil {
			if errors.Is(err, selfmgmt.ErrUpdateScheduled) {
				log.Println("Windows 替换 helper 已启动，当前进程退出以释放可执行文件")
				os.Exit(0)
			}
			log.Printf("远程触发升级失败（不影响采集上报）: %v", err)
			return
		}
		log.Println("远程触发升级流程结束")
	}()
}
