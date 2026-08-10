package agent

import (
	"fmt"
	"net"
	"path/filepath"
	"runtime"
	"time"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/xugou/agent/pkg/selfmgmt"
)

func init() {
	var noProbe bool

	statusCmd := &cobra.Command{
		Use:   "status",
		Short: "显示 Agent 状态与配置信息",
		Long: `显示 Xugou Agent 的当前版本、可执行文件路径、配置文件与关键配置项
（服务器地址、采集/上报间隔、打码后的令牌）、systemd 服务状态，
并对配置的服务器地址做一次 TCP 连通性探测。

示例:
  xugou-agent status              显示完整状态
  xugou-agent status --no-probe   跳过服务器连通性探测`,
		SilenceUsage: true,
		Run: func(cmd *cobra.Command, args []string) {
			runStatus(noProbe)
		},
	}
	statusCmd.Flags().BoolVar(&noProbe, "no-probe", false, "跳过服务器连通性探测")
	rootCmd.AddCommand(statusCmd)
}

func runStatus(noProbe bool) {
	fmt.Println("Xugou Agent 状态:")
	fmt.Printf("  版本:         %s (提交 %s, 构建于 %s)\n", Version, GitCommit, BuildDate)

	// 可执行文件路径
	if exePath, err := selfmgmt.ResolveExecutable(); err != nil {
		fmt.Printf("  可执行文件:   无法获取 (%v)\n", err)
	} else {
		fmt.Printf("  可执行文件:   %s\n", exePath)
	}

	// 配置文件与关键配置
	if used := viper.ConfigFileUsed(); used != "" {
		fmt.Printf("  配置文件:     %s\n", used)
	} else {
		fmt.Printf("  配置文件:     未找到 (默认查找 %s)\n", cfgFile)
	}

	server := viper.GetString("server")
	if server == "" {
		fmt.Println("  服务器地址:   未配置")
	} else {
		fmt.Printf("  服务器地址:   %s\n", server)
	}
	if tokenFile := viper.GetString("token-file"); tokenFile != "" {
		fmt.Printf("  API 凭据:     文件 %s\n", tokenFile)
	} else if token := viper.GetString("token"); token == "" {
		fmt.Println("  API 令牌:     未配置")
	} else {
		fmt.Printf("  API 令牌:     %s\n", selfmgmt.MaskToken(token))
	}
	fmt.Printf("  采集间隔:     %d 秒\n", viper.GetInt("collect-interval"))
	fmt.Printf("  上报间隔:     %d 秒\n", viper.GetInt("report-interval"))
	spoolDir := viper.GetString("spool-dir")
	if spoolDir == "" {
		spoolDir = filepath.Join(filepath.Dir(cfgFile), ".xugou-spool")
	}
	fmt.Printf("  Spool 目录:   %s\n", spoolDir)
	if proxy := viper.GetString("proxy"); proxy != "" {
		fmt.Printf("  代理服务器:   %s\n", proxy)
	}

	printSystemdStatus()

	if noProbe {
		fmt.Println("  服务器探测:   已跳过 (--no-probe)")
	} else {
		printServerProbe(server)
	}
}

// printSystemdStatus 输出 systemd 服务状态（非 Linux/无 systemd 环境优雅降级）
func printSystemdStatus() {
	state := selfmgmt.ServiceState()
	if !state.Available {
		if runtime.GOOS != "linux" {
			fmt.Printf("  systemd 服务: 不适用 (%s 平台)\n", runtime.GOOS)
		} else {
			fmt.Println("  systemd 服务: 不适用 (未检测到 systemctl)")
		}
		return
	}
	if !state.Installed() {
		fmt.Printf("  systemd 服务: 未安装 (未找到 %s)\n", selfmgmt.ServiceUnitPath)
		return
	}
	active := selfmgmt.SystemctlOutput("is-active", selfmgmt.ServiceName)
	enabled := selfmgmt.SystemctlOutput("is-enabled", selfmgmt.ServiceName)
	fmt.Printf("  systemd 服务: %s (is-active: %s, is-enabled: %s)\n", selfmgmt.ServiceName, active, enabled)
}

// printServerProbe 对配置的服务器做一次 TCP 连通性探测
func printServerProbe(server string) {
	if server == "" {
		fmt.Println("  服务器探测:   已跳过 (未配置服务器地址)")
		return
	}
	target, err := selfmgmt.ProbeTarget(server)
	if err != nil {
		fmt.Printf("  服务器探测:   无法解析地址 (%v)\n", err)
		return
	}
	start := time.Now()
	conn, err := net.DialTimeout("tcp", target, 3*time.Second)
	if err != nil {
		fmt.Printf("  服务器探测:   不可达 (%s): %v\n", target, err)
		return
	}
	conn.Close()
	fmt.Printf("  服务器探测:   可达 (%s, 耗时 %s)\n", target, time.Since(start).Round(time.Millisecond))
}
