package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

var (
	cfgFile string
	rootCmd = &cobra.Command{
		Use:   "xugou-agent",
		Short: "Xugou Agent - 系统监控客户端",
		Long: `Xugou Agent 是一个系统监控客户端，用于收集系统信息并上报到监控服务器。
它可以收集 CPU、内存、磁盘、网络等系统信息，并定期上报到指定的服务器。`,
	}
)

// Execute 执行根命令
func Execute() error {
	return rootCmd.Execute()
}

func init() {
	cobra.OnInitialize(initConfig)

	rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "", "配置文件路径 (默认为 $HOME/.xugou-agent.yaml)")
	rootCmd.PersistentFlags().String("server", "", "监控服务器地址（例如:https://api.xugou.mdzz.uk）")
	rootCmd.PersistentFlags().String("token", "", "API 令牌（例如： xugou_maxln220_df8900585981ab775b36dcaaaee772d8.f668c0cf84d1840d）")
	rootCmd.PersistentFlags().String("token-file", "", "API 凭据文件路径（Unix 权限需为 0600）")
	rootCmd.PersistentFlags().StringSlice("devices", []string{}, "指定监控的硬盘设备列表 (例如: /dev/sda1,/dev/sdb1)")
	rootCmd.PersistentFlags().StringSlice("interfaces", []string{}, "指定监控的网络接口列表 (例如: eth0,wlan0)")
	rootCmd.PersistentFlags().IntP("interval", "i", 60, "兼容旧配置：数据采集和上报间隔（秒）")
	rootCmd.PersistentFlags().Int("collect-interval", 1, "本机轻量指标采集间隔（秒）")
	rootCmd.PersistentFlags().Int("report-interval", 60, "向服务器批量上报间隔（秒）")
	rootCmd.PersistentFlags().String("spool-dir", "", "持久化采样队列目录（默认与配置文件同目录）")
	rootCmd.PersistentFlags().Int64("spool-max-bytes", 64*1024*1024, "持久化采样队列大小上限（字节）")
	rootCmd.PersistentFlags().Int("report-max-compressed-bytes", 64*1024, "单个 gzip 上报批次大小上限（字节）")
	rootCmd.PersistentFlags().StringP("proxy", "p", "", "HTTP代理服务器地址（例如：http://proxy.example.com:8080）")

	viper.BindPFlag("interval", rootCmd.PersistentFlags().Lookup("interval"))
	viper.BindPFlag("collect-interval", rootCmd.PersistentFlags().Lookup("collect-interval"))
	viper.BindPFlag("report-interval", rootCmd.PersistentFlags().Lookup("report-interval"))
	viper.BindPFlag("spool-dir", rootCmd.PersistentFlags().Lookup("spool-dir"))
	viper.BindPFlag("spool-max-bytes", rootCmd.PersistentFlags().Lookup("spool-max-bytes"))
	viper.BindPFlag("report-max-compressed-bytes", rootCmd.PersistentFlags().Lookup("report-max-compressed-bytes"))
	viper.BindPFlag("proxy", rootCmd.PersistentFlags().Lookup("proxy"))
	viper.BindPFlag("server", rootCmd.PersistentFlags().Lookup("server"))
	viper.BindPFlag("token", rootCmd.PersistentFlags().Lookup("token"))
	viper.BindPFlag("token-file", rootCmd.PersistentFlags().Lookup("token-file"))
	viper.BindPFlag("devices", rootCmd.PersistentFlags().Lookup("devices"))
	viper.BindPFlag("interfaces", rootCmd.PersistentFlags().Lookup("interfaces"))
}

func initConfig() {
	if cfgFile != "" {
		// 使用指定的配置文件
		viper.SetConfigFile(cfgFile)
	} else {
		// 查找用户主目录
		home, err := os.UserHomeDir()
		if err != nil {
			fmt.Println("错误: 无法获取用户主目录:", err)
			os.Exit(1)
		}

		// 在主目录中查找 .xugou-agent.yaml 文件
		viper.AddConfigPath(home)
		viper.SetConfigName(".xugou-agent")
		viper.SetConfigType("yaml")
		cfgFile = filepath.Join(home, ".xugou-agent.yaml")
	}

	// 读取环境变量
	viper.SetEnvPrefix("XUGOU")
	viper.SetEnvKeyReplacer(strings.NewReplacer("-", "_"))
	viper.AutomaticEnv()

	// 如果找到配置文件，则读取它。
	// 诊断信息走 stderr，保证 `version --short` 等机器可读输出的 stdout 干净。
	if err := viper.ReadInConfig(); err == nil {
		fmt.Fprintln(os.Stderr, "使用配置文件:", viper.ConfigFileUsed())
	} else {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			fmt.Fprintln(os.Stderr, "警告: 配置文件读取错误:", err)
		}
	}
}
