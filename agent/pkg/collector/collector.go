package collector

import (
	"context"
	"fmt"
	"runtime"
	"sync"
	"time"

	"github.com/spf13/viper"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/load"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
	"github.com/xugou/agent/pkg/config"
	"github.com/xugou/agent/pkg/model"
	"github.com/xugou/agent/pkg/utils"
)

// Collector 定义数据收集器接口
type Collector interface {
	Collect(ctx context.Context) (*model.SystemInfo, error)
	CollectBatch(ctx context.Context) ([]*model.SystemInfo, error) // 批量采集一段时间内的系统信息
}

type stableMetadata struct {
	Hostname string
	Platform string
	OS       string
	Version  string
	CPUModel string
	CPUCores int
	BootTime int64 // Unix 秒，开机后不变，随稳定元数据缓存
}

// DefaultCollector 是默认的数据收集器实现
type DefaultCollector struct {
	stableMu       sync.RWMutex
	stableMetadata *stableMetadata
	prober         netProber
	conns          connCounter
}

// NewCollector 创建一个新的数据收集器
func NewCollector() Collector {
	return &DefaultCollector{}
}

func (c *DefaultCollector) getStableMetadata() (*stableMetadata, error) {
	c.stableMu.RLock()
	if c.stableMetadata != nil {
		metadata := c.stableMetadata
		c.stableMu.RUnlock()
		return metadata, nil
	}
	c.stableMu.RUnlock()

	c.stableMu.Lock()
	defer c.stableMu.Unlock()

	if c.stableMetadata != nil {
		return c.stableMetadata, nil
	}

	hostInfo, err := host.Info()
	if err != nil {
		return nil, fmt.Errorf("获取主机信息失败: %w", err)
	}

	cpuInfo, err := cpu.Info()
	if err != nil {
		return nil, fmt.Errorf("获取CPU信息失败: %w", err)
	}

	var modelName string
	if len(cpuInfo) > 0 {
		modelName = cpuInfo[0].ModelName
	}

	c.stableMetadata = &stableMetadata{
		Hostname: hostInfo.Hostname,
		Platform: hostInfo.Platform,
		OS:       hostInfo.OS,
		Version:  fmt.Sprintf("%s %s (%s)", hostInfo.Platform, hostInfo.PlatformVersion, hostInfo.KernelVersion),
		CPUModel: modelName,
		CPUCores: runtime.NumCPU(),
		BootTime: int64(hostInfo.BootTime),
	}

	return c.stableMetadata, nil
}

// Collect 收集系统信息
func (c *DefaultCollector) Collect(ctx context.Context) (*model.SystemInfo, error) {
	info := &model.SystemInfo{
		Timestamp:              time.Now(),
		Keepalive:              config.ReportInterval,
		CollectIntervalSeconds: config.CollectInterval,
		ReportIntervalSeconds:  config.ReportInterval,
	}

	info.Token = config.Token

	metadata, err := c.getStableMetadata()
	if err != nil {
		return nil, err
	}
	info.Hostname = metadata.Hostname
	info.Platform = metadata.Platform
	info.OS = metadata.OS
	info.Version = metadata.Version
	info.BootTime = metadata.BootTime

	// 获取本地IP地址
	info.IPAddresses = utils.GetLocalIPs()

	// 获取CPU信息
	cpuPercent, err := cpu.Percent(time.Second, false)
	if err != nil {
		return nil, fmt.Errorf("获取CPU使用率失败: %w", err)
	}

	info.CPU = model.CPUInfo{
		Usage:     cpuPercent[0],
		Cores:     metadata.CPUCores,
		ModelName: metadata.CPUModel,
	}

	// 获取内存信息
	memInfo, err := mem.VirtualMemory()
	if err != nil {
		return nil, fmt.Errorf("获取内存信息失败: %w", err)
	}

	info.Memory = model.MemoryInfo{
		Total:     memInfo.Total,
		Used:      memInfo.Used,
		Free:      memInfo.Free,
		UsageRate: memInfo.UsedPercent,
	}

	// 获取磁盘信息
	configDevices := viper.GetStringSlice("devices")
	deviceSet := make(map[string]struct{})
	for _, d := range configDevices {
		deviceSet[d] = struct{}{}
	}

	partitions, err := disk.Partitions(false)
	if err != nil {
		return nil, fmt.Errorf("获取磁盘分区信息失败: %w", err)
	}

	for _, partition := range partitions {
		// 如果指定了设备列表，并且当前分区不在列表中，则跳过
		if len(configDevices) > 0 {
			_, deviceMatch := deviceSet[partition.Device]
			_, mountpointMatch := deviceSet[partition.Mountpoint]
			if !deviceMatch && !mountpointMatch {
				continue
			}
		}

		usage, err := disk.Usage(partition.Mountpoint)
		if err != nil {
			// log.Printf("获取磁盘 %s 使用情况失败: %v", partition.Mountpoint, err) // 可选的日志记录
			continue
		}

		diskInfo := model.DiskInfo{
			Device:     partition.Device,
			MountPoint: partition.Mountpoint,
			Total:      usage.Total,
			Used:       usage.Used,
			Free:       usage.Free,
			UsageRate:  usage.UsedPercent,
			FSType:     partition.Fstype,
		}
		info.Disks = append(info.Disks, diskInfo)
	}

	// 获取网络信息
	configInterfaces := viper.GetStringSlice("interfaces")
	interfaceSet := make(map[string]struct{})
	for _, i := range configInterfaces {
		interfaceSet[i] = struct{}{}
	}

	netIOCounters, err := net.IOCounters(true)
	if err != nil {
		return nil, fmt.Errorf("获取网络信息失败: %w", err)
	}

	for _, netIO := range netIOCounters {
		// 如果指定了接口列表，并且当前接口不在列表中，则跳过
		if len(configInterfaces) > 0 {
			if _, ok := interfaceSet[netIO.Name]; !ok {
				continue
			}
		}
		networkInfo := model.NetworkInfo{
			Interface:   netIO.Name,
			BytesSent:   netIO.BytesSent,
			BytesRecv:   netIO.BytesRecv,
			PacketsSent: netIO.PacketsSent,
			PacketsRecv: netIO.PacketsRecv,
		}
		info.Network = append(info.Network, networkInfo)
	}

	// 获取系统负载
	loadAvg, err := load.Avg()
	if err == nil {
		info.Load = model.LoadInfo{
			Load1:  loadAvg.Load1,
			Load5:  loadAvg.Load5,
			Load15: loadAvg.Load15,
		}
	}

	// 获取 Swap 信息（拿不到时省略，不报错）
	if swapInfo, err := mem.SwapMemory(); err == nil {
		info.Swap = &model.SwapInfo{
			Total:     swapInfo.Total,
			Used:      swapInfo.Used,
			UsageRate: swapInfo.UsedPercent,
		}
	}

	// 获取进程数（拿不到时保持零值）
	if pids, err := process.PidsWithContext(ctx); err == nil {
		info.ProcessCount = len(pids)
	}

	// 获取 TCP/UDP 连接数（大机器上枚举连接可能很慢，30s TTL 缓存 + 超时保护）
	tcpCount, udpCount := c.conns.current(ctx)
	info.TCPConnections = tcpCount
	info.UDPConnections = udpCount

	// 四线路拨测 + IPv4/IPv6 可达性（独立 30s 周期，结果缓存复用）
	snapshot := c.prober.current(ctx)
	if len(snapshot.ping) > 0 {
		info.Ping = snapshot.ping
	}
	ipv4 := snapshot.ipv4Reachable
	ipv6 := snapshot.ipv6Reachable
	info.IPv4Reachable = &ipv4
	info.IPv6Reachable = &ipv6

	return info, nil
}

const (
	// connectionCountTimeout 枚举连接数的超时上限
	connectionCountTimeout = 5 * time.Second
	// connectionCountInterval 连接数结果缓存周期（与 netProber 的 probeInterval 同思路）：
	// 完整枚举两次连接开销较大，采集频率再高也最多每 30s 枚举一次
	connectionCountInterval = 30 * time.Second
)

// connCounter 带 TTL 缓存的 TCP/UDP 连接数统计
type connCounter struct {
	mu          sync.Mutex
	tcp, udp    int
	collectedAt time.Time
}

// current 返回缓存的连接数，缓存过期时重新枚举（错误或超时缓存零值）
func (c *connCounter) current(ctx context.Context) (int, int) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.collectedAt.IsZero() && time.Since(c.collectedAt) < connectionCountInterval {
		return c.tcp, c.udp
	}
	c.tcp, c.udp = countConnections(ctx)
	c.collectedAt = time.Now()
	return c.tcp, c.udp
}

// countConnections 统计 TCP/UDP 连接数；错误或超时返回零值。
// 注意：超时返回后枚举 goroutine 仍会跑完（gopsutil 对取消不敏感），
// resultCh 带缓冲保证其不会泄漏。
func countConnections(ctx context.Context) (int, int) {
	type result struct {
		tcp int
		udp int
	}

	countCtx, cancel := context.WithTimeout(ctx, connectionCountTimeout)
	defer cancel()

	resultCh := make(chan result, 1)
	go func() {
		var r result
		if conns, err := net.ConnectionsWithContext(countCtx, "tcp"); err == nil {
			r.tcp = len(conns)
		}
		if conns, err := net.ConnectionsWithContext(countCtx, "udp"); err == nil {
			r.udp = len(conns)
		}
		resultCh <- r
	}()

	select {
	case r := <-resultCh:
		return r.tcp, r.udp
	case <-countCtx.Done():
		return 0, 0
	}
}

// CollectBatch 在指定时间段内批量收集系统信息，现在只采集一条，以后再扩展
func (c *DefaultCollector) CollectBatch(ctx context.Context) ([]*model.SystemInfo, error) {
	// 创建结果切片
	results := make([]*model.SystemInfo, 0)

	// 采集第一条数据
	info, err := c.Collect(ctx)
	if err != nil {
		return nil, err
	}
	results = append(results, info)

	return results, nil
}
