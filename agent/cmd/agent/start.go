package agent

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/xugou/agent/pkg/buffer"
	"github.com/xugou/agent/pkg/collector"
	"github.com/xugou/agent/pkg/config"
	"github.com/xugou/agent/pkg/model"
	"github.com/xugou/agent/pkg/reporter"
)

func init() {
	startCmd := &cobra.Command{
		Use:   "start",
		Short: "启动 Xugou Agent",
		Long:  `启动 Xugou Agent 开始采集系统信息并上报到服务器`,
		Run:   runStart,
	}
	rootCmd.AddCommand(startCmd)
}

func runStart(cmd *cobra.Command, args []string) {

	config.ServerURL = viper.GetString("server")
	config.Token = viper.GetString("token")
	config.Interval = viper.GetInt("interval")
	config.CollectInterval = viper.GetInt("collect-interval")
	config.ReportInterval = viper.GetInt("report-interval")
	config.ProxyURL = viper.GetString("proxy")
	config.ConfigFilePath = cfgFile
	// 上报请求以 X-Agent-Version 携带探针版本（服务端据此判断是否触发自升级）
	config.AgentVersion = Version
	// 检查必要的配置
	if config.Interval <= 0 {
		config.Interval = 60
	}
	if config.CollectInterval <= 0 {
		config.CollectInterval = config.Interval
	}
	if config.ReportInterval <= 0 {
		config.ReportInterval = config.Interval
	}
	if config.ReportInterval < config.CollectInterval {
		config.ReportInterval = config.CollectInterval
	}

	if config.Token == "" {
		fmt.Println("错误: 未设置 API 令牌，请使用 --token 参数或在配置文件中设置")
		os.Exit(1)
	}

	if config.ServerURL == "" {
		fmt.Println("错误: 未设置服务器地址，请使用 --server 参数或在配置文件中设置")
		os.Exit(1)
	}

	fmt.Println("Xugou Agent 启动中...")
	fmt.Printf("服务器地址: %s\n", config.ServerURL)
	fmt.Printf("采集数据间隔: %d秒\n", config.CollectInterval)
	fmt.Printf("上报数据间隔: %d秒\n", config.ReportInterval)
	if config.ProxyURL != "" {
		fmt.Printf("使用代理服务器: %s\n", config.ProxyURL)
	}
	fmt.Println("使用令牌自动注册/上报数据")

	// 设置上下文，用于处理取消信号
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 初始化数据收集器和上报器
	dataCollector := collector.NewCollector()
	dataReporter := reporter.NewReporter()
	fmt.Println("使用HTTP上报器")

	collectTicker := time.NewTicker(time.Duration(config.CollectInterval) * time.Second)
	defer collectTicker.Stop()
	reportTicker := time.NewTicker(time.Duration(config.ReportInterval) * time.Second)
	defer reportTicker.Stop()

	// 设置信号处理，用于优雅退出
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	fmt.Println("Xugou Agent 已启动，按 Ctrl+C 停止")

	// 采集样本进内存环形缓冲（上限 300 条），上报失败时保留待下轮重报
	samples := buffer.NewRing[*model.SystemInfo](buffer.DefaultCapacity)
	collectSample(ctx, dataCollector, samples)
	reportSamples(ctx, dataReporter, samples, collectTicker, reportTicker)

	// 主循环
	for {
		select {
		case <-collectTicker.C:
			collectSample(ctx, dataCollector, samples)
		case <-reportTicker.C:
			if samples.Len() == 0 {
				collectSample(ctx, dataCollector, samples)
			}
			reportSamples(ctx, dataReporter, samples, collectTicker, reportTicker)
		case sig := <-sigCh:
			fmt.Printf("收到信号 %v，正在停止...\n", sig)
			return
		}
	}
}

func collectSample(ctx context.Context, c collector.Collector, samples *buffer.Ring[*model.SystemInfo]) {
	timeoutSeconds := max(config.CollectInterval, 15)
	roundCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSeconds)*time.Second)
	defer cancel()

	info, err := c.Collect(roundCtx)
	if err != nil {
		fmt.Printf("采集系统信息失败: %v\n", err)
		return
	}

	samples.Push(info)
	fmt.Printf("采集到系统信息，缓冲区样本数: %d\n", samples.Len())
}

func reportSamples(
	ctx context.Context,
	r reporter.Reporter,
	samples *buffer.Ring[*model.SystemInfo],
	collectTicker *time.Ticker,
	reportTicker *time.Ticker,
) {
	if samples.Len() == 0 {
		return
	}

	timeoutSeconds := max(config.ReportInterval, 15)
	roundCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSeconds)*time.Second)
	defer cancel()

	// 先快照上报，成功后再清空，失败时样本保留在缓冲中等待下轮
	pending := samples.Snapshot()
	remoteConfig, err := r.ReportBatch(roundCtx, pending)
	if err != nil {
		fmt.Printf("上报系统信息失败: %v\n", err)
		return
	}
	samples.Clear()
	fmt.Printf("系统信息已收集并上报，时间: %s\n", time.Now().Format("2006-01-02 15:04:05"))

	if remoteConfig != nil {
		applyRemoteConfig(remoteConfig, collectTicker, reportTicker)
		// v3 update 指令：异步触发自升级（互斥防重入，失败只记日志，不落配置文件）
		if remoteConfig.Update {
			TriggerRemoteUpdate()
		}
	}
}

// applyRemoteConfig 应用服务端下发的新配置：原子持久化 + 热更新运行中的定时器。
// 持久化失败只告警，内存配置仍然生效（本地 MD5 随内存值变化，重启后会重新拉取）。
func applyRemoteConfig(
	remote *config.RemoteConfig,
	collectTicker *time.Ticker,
	reportTicker *time.Ticker,
) {
	if remote.CollectInterval == config.CollectInterval &&
		remote.ReportInterval == config.ReportInterval {
		return
	}

	fmt.Printf(
		"收到服务端配置下发: 采集间隔 %d秒 -> %d秒, 上报间隔 %d秒 -> %d秒\n",
		config.CollectInterval, remote.CollectInterval,
		config.ReportInterval, remote.ReportInterval,
	)

	if err := config.PersistIntervals(
		config.ConfigFilePath, remote.CollectInterval, remote.ReportInterval,
	); err != nil {
		fmt.Printf("警告: 持久化服务端配置失败（仅内存生效）: %v\n", err)
	}

	config.CollectInterval = remote.CollectInterval
	config.ReportInterval = remote.ReportInterval
	collectTicker.Reset(time.Duration(config.CollectInterval) * time.Second)
	reportTicker.Reset(time.Duration(config.ReportInterval) * time.Second)
}
