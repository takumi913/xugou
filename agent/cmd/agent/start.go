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

	samples := make([]*model.SystemInfo, 0, 1)
	collectSample(ctx, dataCollector, &samples)
	reportSamples(ctx, dataReporter, &samples)

	// 主循环
	for {
		select {
		case <-collectTicker.C:
			collectSample(ctx, dataCollector, &samples)
		case <-reportTicker.C:
			if len(samples) == 0 {
				collectSample(ctx, dataCollector, &samples)
			}
			reportSamples(ctx, dataReporter, &samples)
		case sig := <-sigCh:
			fmt.Printf("收到信号 %v，正在停止...\n", sig)
			return
		}
	}
}

func collectSample(ctx context.Context, c collector.Collector, samples *[]*model.SystemInfo) {
	timeoutSeconds := config.CollectInterval
	if timeoutSeconds < 15 {
		timeoutSeconds = 15
	}
	roundCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSeconds)*time.Second)
	defer cancel()

	info, err := c.Collect(roundCtx)
	if err != nil {
		fmt.Printf("采集系统信息失败: %v\n", err)
		return
	}

	*samples = append(*samples, info)
	if len(*samples) > 100 {
		*samples = (*samples)[len(*samples)-100:]
	}
	fmt.Printf("采集到系统信息，缓冲区样本数: %d\n", len(*samples))
}

func reportSamples(ctx context.Context, r reporter.Reporter, samples *[]*model.SystemInfo) {
	if len(*samples) == 0 {
		return
	}

	timeoutSeconds := config.ReportInterval
	if timeoutSeconds < 15 {
		timeoutSeconds = 15
	}
	roundCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSeconds)*time.Second)
	defer cancel()

	err := r.ReportBatch(roundCtx, *samples)
	if err != nil {
		fmt.Printf("上报系统信息失败: %v\n", err)
		return
	}
	*samples = (*samples)[:0]
	fmt.Printf("系统信息已收集并上报，时间: %s\n", time.Now().Format("2006-01-02 15:04:05"))
}
