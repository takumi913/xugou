package agent

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/xugou/agent/pkg/selfmgmt"
)

func init() {
	var skipConfirm bool

	uninstallCmd := &cobra.Command{
		Use:   "uninstall",
		Short: "卸载 Xugou Agent",
		Long: `卸载 Xugou Agent：停止并移除 systemd 服务（如存在）、删除配置文件，
最后删除当前可执行文件自身。

执行前会列出将要删除的内容并要求确认（--yes 可跳过确认）。
每个步骤失败时会继续执行后续步骤，并在结束时汇总结果。
在 Linux 上移除 systemd 服务及 /usr/local/bin 下的二进制通常需要 root 权限（sudo）。

示例:
  sudo xugou-agent uninstall          交互确认后卸载
  sudo xugou-agent uninstall --yes    跳过确认直接卸载`,
		SilenceUsage:  true,
		SilenceErrors: true, // main 函数会统一打印错误，避免重复输出
		RunE: func(cmd *cobra.Command, args []string) error {
			return runUninstall(skipConfirm)
		},
	}
	uninstallCmd.Flags().BoolVarP(&skipConfirm, "yes", "y", false, "跳过交互确认")
	rootCmd.AddCommand(uninstallCmd)
}

// uninstallStep 卸载步骤：描述 + 执行函数
type uninstallStep struct {
	desc string
	run  func() error
}

func runUninstall(skipConfirm bool) error {
	exePath, err := selfmgmt.ResolveExecutable()
	if err != nil {
		return fmt.Errorf("无法确定当前可执行文件路径: %w", err)
	}

	configPath := usedConfigFile()
	state := selfmgmt.ServiceState()
	unitExists := state.UnitExists
	serviceKnown := state.Installed()

	// --- 打印将要删除的内容清单 ---
	fmt.Println("将执行以下卸载操作:")
	var steps []uninstallStep
	if serviceKnown {
		steps = append(steps, uninstallStep{
			desc: fmt.Sprintf("停止并禁用 systemd 服务 %s", selfmgmt.ServiceName),
			run: func() error {
				stopErr := selfmgmt.Systemctl("stop", selfmgmt.ServiceName)
				disableErr := selfmgmt.Systemctl("disable", selfmgmt.ServiceName)
				if stopErr != nil {
					return stopErr
				}
				return disableErr
			},
		})
	}
	if unitExists {
		steps = append(steps, uninstallStep{
			desc: fmt.Sprintf("删除服务文件 %s 并执行 daemon-reload", selfmgmt.ServiceUnitPath),
			run: func() error {
				if err := os.Remove(selfmgmt.ServiceUnitPath); err != nil {
					return err
				}
				return selfmgmt.Systemctl("daemon-reload")
			},
		})
	}
	if configPath != "" {
		steps = append(steps, uninstallStep{
			desc: fmt.Sprintf("删除配置文件 %s", configPath),
			run:  func() error { return os.Remove(configPath) },
		})
	}
	steps = append(steps, uninstallStep{
		desc: fmt.Sprintf("删除可执行文件 %s", exePath),
		run:  func() error { return os.Remove(exePath) },
	})

	for _, s := range steps {
		fmt.Printf("  - %s\n", s.desc)
	}
	if serviceKnown && !selfmgmt.IsRoot() {
		fmt.Println("警告: 当前非 root 用户，systemd 相关操作可能失败，建议使用 sudo 执行。")
	}

	// --- 交互确认 ---
	if !skipConfirm {
		fmt.Print("确认卸载? [y/N]: ")
		reader := bufio.NewReader(os.Stdin)
		line, _ := reader.ReadString('\n')
		answer := strings.ToLower(strings.TrimSpace(line))
		if answer != "y" && answer != "yes" {
			fmt.Println("已取消卸载。")
			return nil
		}
	}

	// --- 逐步执行，失败继续 ---
	var failures []string
	for _, s := range steps {
		fmt.Printf("执行: %s ... ", s.desc)
		if err := s.run(); err != nil {
			fmt.Printf("失败: %v\n", err)
			failures = append(failures, fmt.Sprintf("%s: %v", s.desc, err))
			continue
		}
		fmt.Println("完成")
	}

	fmt.Println()
	if len(failures) == 0 {
		fmt.Println("Xugou Agent 已卸载完成。感谢使用!")
		return nil
	}
	fmt.Printf("卸载完成，但有 %d 个步骤失败:\n", len(failures))
	for _, f := range failures {
		fmt.Printf("  - %s\n", f)
	}
	if !selfmgmt.IsRoot() {
		fmt.Println("提示: 部分失败可能因权限不足，可尝试: sudo xugou-agent uninstall --yes")
	}
	return fmt.Errorf("部分卸载步骤失败")
}

// usedConfigFile 返回实际生效的配置文件路径；不存在时返回空串
func usedConfigFile() string {
	if used := viper.ConfigFileUsed(); used != "" {
		return used
	}
	if cfgFile != "" {
		if _, err := os.Stat(cfgFile); err == nil {
			return cfgFile
		}
	}
	return ""
}
