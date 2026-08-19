package agent

import (
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/xugou/agent/pkg/collector"
	"github.com/xugou/agent/pkg/config"
	"github.com/xugou/agent/pkg/model"
	"github.com/xugou/agent/pkg/realtime"
	"github.com/xugou/agent/pkg/reporter"
	"github.com/xugou/agent/pkg/spool"
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
	config.TokenFile = viper.GetString("token-file")
	if config.TokenFile != "" {
		fileToken, err := config.LoadTokenFile(config.TokenFile)
		if err != nil {
			fmt.Printf("加载 API 凭据文件失败: %v\n", err)
			return
		}
		config.Token = fileToken
	}
	config.Interval = viper.GetInt("interval")
	collectInterval, reportInterval, intervalErr := config.ResolveIntervals(
		config.Interval,
		viper.GetInt("collect-interval"),
		viper.GetInt("report-interval"),
		configurationKeySet(cmd, "interval"),
		configurationKeySet(cmd, "collect-interval"),
		configurationKeySet(cmd, "report-interval"),
	)
	if intervalErr != nil {
		fmt.Printf("采集/上报间隔配置错误: %v\n", intervalErr)
		return
	}
	config.CollectInterval = collectInterval
	config.ReportInterval = reportInterval
	config.ProxyURL = viper.GetString("proxy")
	config.SpoolDir = viper.GetString("spool-dir")
	config.SpoolMaxBytes = viper.GetInt64("spool-max-bytes")
	config.ReportMaxCompressedBytes = viper.GetInt("report-max-compressed-bytes")
	config.ConfigFilePath = cfgFile
	// 上报请求以 X-Agent-Version 携带探针版本（服务端据此判断是否触发自升级）
	config.AgentVersion = Version
	// 检查必要的配置
	if config.SpoolDir == "" {
		config.SpoolDir = filepath.Join(filepath.Dir(config.ConfigFilePath), ".xugou-spool")
	}
	if config.SpoolMaxBytes <= 0 {
		config.SpoolMaxBytes = spool.DefaultMaxBytes
	}
	if config.ReportMaxCompressedBytes <= 0 {
		config.ReportMaxCompressedBytes = spool.DefaultMaxCompressedBytes
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
	fmt.Printf("持久化采样队列: %s (上限 %d 字节)\n", config.SpoolDir, config.SpoolMaxBytes)
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
	liveClient, err := realtime.NewClient(
		config.ServerURL,
		config.Token,
		config.AgentVersion,
		config.ProxyURL,
	)
	if err != nil {
		fmt.Printf("初始化实时 WebSocket 失败: %v\n", err)
		return
	}
	sampleSpool, err := spool.Open(spool.Options{
		Dir:        config.SpoolDir,
		MaxBytes:   config.SpoolMaxBytes,
		MaxEntries: spool.DefaultMaxEntries,
	})
	if err != nil {
		fmt.Printf("初始化持久化采样队列失败: %v\n", err)
		return
	}
	if discarded := sampleSpool.Discarded(); len(discarded) > 0 {
		fmt.Printf("已丢弃 %d 个旧版本残留的 spool 文件（结构不兼容，将重新组批）\n",
			len(discarded))
	}
	fmt.Println("使用实时 WebSocket + HTTP 批量上报器")
	go liveClient.Run(ctx)

	collectTicker := time.NewTicker(time.Duration(config.CollectInterval) * time.Second)
	defer collectTicker.Stop()
	configUpdates := make(chan remoteConfigUpdate)

	// 设置信号处理，用于优雅退出
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	fmt.Println("Xugou Agent 已启动，按 Ctrl+C 停止")

	// 每次采集立即进入实时最新值通道并原子落盘；HTTP 成功后才删除 inflight。
	collectSample(ctx, dataCollector, sampleSpool, liveClient)
	go runReportLoop(ctx, dataReporter, sampleSpool, configUpdates)

	// 主循环
	for {
		select {
		case <-collectTicker.C:
			collectSample(ctx, dataCollector, sampleSpool, liveClient)
		case update := <-configUpdates:
			applyRemoteConfig(update.config, collectTicker)
			if update.config.Update {
				TriggerRemoteUpdate()
			}
			close(update.applied)
		case sig := <-sigCh:
			fmt.Printf("收到信号 %v，正在停止...\n", sig)
			return
		}
	}
}

type remoteConfigUpdate struct {
	config  *config.RemoteConfig
	applied chan struct{}
}

// runReportLoop 与秒级采集循环完全独立。HTTP 超时、退避和断线补偿不会暂停
// 本地采集、Spool 写入或实时 WebSocket 发布。
func runReportLoop(
	ctx context.Context,
	r reporter.Reporter,
	samples *spool.Store,
	updates chan<- remoteConfigUpdate,
) {
	reportTicker := time.NewTicker(time.Duration(config.ReportInterval) * time.Second)
	defer reportTicker.Stop()

	report := func() bool {
		remote := reportSamples(ctx, r, samples)
		if remote == nil {
			return true
		}
		update := remoteConfigUpdate{config: remote, applied: make(chan struct{})}
		select {
		case <-ctx.Done():
			return false
		case updates <- update:
		}
		select {
		case <-ctx.Done():
			return false
		case <-update.applied:
			reportTicker.Reset(time.Duration(remote.ReportInterval) * time.Second)
			return true
		}
	}

	// 启动时先发送首条样本完成 Enrollment 注册，之后进入固定批量周期。
	if !report() {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-reportTicker.C:
			if !report() {
				return
			}
		}
	}
}

func configurationKeySet(cmd *cobra.Command, key string) bool {
	flagSet := cmd.Flags().Lookup(key)
	if flagSet != nil && flagSet.Changed {
		return true
	}
	envKey := "XUGOU_" + strings.ToUpper(strings.ReplaceAll(key, "-", "_"))
	if _, exists := os.LookupEnv(envKey); exists {
		return true
	}
	return viper.InConfig(key)
}

type liveMetricPublisher interface {
	Publish(info *model.SystemInfo)
}

func collectSample(
	ctx context.Context,
	c collector.Collector,
	samples *spool.Store,
	live liveMetricPublisher,
) {
	timeoutSeconds := max(config.CollectInterval, 15)
	roundCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSeconds)*time.Second)
	defer cancel()

	info, err := c.Collect(roundCtx)
	if err != nil {
		fmt.Printf("采集系统信息失败: %v\n", err)
		return
	}

	// 实时路径只保存一个最新内存帧，网络写入由独立 goroutine 完成。
	// 即使 WebSocket 断开，下面的本地 spool 仍持续写入。
	live.Publish(info)

	dropped, err := samples.Add(info)
	if err != nil {
		fmt.Printf("持久化采集样本失败: %v\n", err)
		return
	}
	if dropped > 0 {
		fmt.Printf("持久化采样队列达到上限，本轮丢弃最旧样本: %d\n", dropped)
	}
}

func reportSamples(
	ctx context.Context,
	r reporter.Reporter,
	samples *spool.Store,
) *config.RemoteConfig {
	timeoutSeconds := max(config.ReportInterval, 15)
	roundCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSeconds)*time.Second)
	defer cancel()

	// 每个上报周期只发送一个批次。DefaultMaxSamples 足以容纳一分钟的秒级
	// 采样；断网期间由有界 Spool 保存最近窗口，恢复后也不会形成 HTTP 请求风暴。
	pending, ok, err := samples.Next(spool.DefaultMaxSamples, config.ReportMaxCompressedBytes)
	if err != nil {
		fmt.Printf("创建持久化上报批次失败: %v\n", err)
		return nil
	}
	if !ok {
		return nil
	}
	remoteConfig, err := reportWithBackoff(roundCtx, r, pending)
	if err != nil {
		fmt.Printf("上报系统信息失败: %v\n", err)
		return nil
	}
	if err := samples.Ack(pending.ReportID); err != nil {
		fmt.Printf("提交已确认上报批次失败: report_id=%s err=%v\n", pending.ReportID, err)
		return remoteConfig
	}
	fmt.Printf("系统信息已确认上报，report_id=%s, 块数=%d, 样本数=%d, 时间=%s\n",
		pending.ReportID, len(pending.Blocks), pending.SampleCount(),
		time.Now().Format("2006-01-02 15:04:05"))
	return remoteConfig
}

func reportWithBackoff(
	ctx context.Context,
	r reporter.Reporter,
	report *model.AgentReport,
) (*config.RemoteConfig, error) {
	const maxAttempts = 5
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		remote, err := r.Report(ctx, report)
		if err == nil {
			return remote, nil
		}
		lastErr = err
		if attempt == maxAttempts-1 {
			break
		}
		base := min(2*time.Second*time.Duration(1<<attempt), 30*time.Second)
		jitter := time.Duration(rand.Int64N(max(int64(base/4), 1)))
		delay := base + jitter
		fmt.Printf("v4 上报将在 %s 后重试: report_id=%s attempt=%d/%d err=%v\n", delay.Round(time.Millisecond), report.ReportID, attempt+1, maxAttempts, err)
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	return nil, lastErr
}

// applyRemoteConfig 应用服务端下发的新配置：原子持久化 + 热更新运行中的定时器。
// 持久化失败只告警，内存配置仍然生效（本地 MD5 随内存值变化，重启后会重新拉取）。
func applyRemoteConfig(
	remote *config.RemoteConfig,
	collectTicker *time.Ticker,
) {
	intervalsChanged := remote.CollectInterval != config.CollectInterval ||
		remote.ReportInterval != config.ReportInterval
	if intervalsChanged {
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
	}
}
