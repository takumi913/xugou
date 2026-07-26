package model

import "time"

// DynamicMetrics 每次采集都会变化的动态指标，由 SystemInfo 与 Sample 匿名内嵌共用。
// 内嵌时不带 json tag，字段在两者的 JSON 中平铺，字段名由此处的 tag 唯一决定
// （服务端 zod 依赖这些字段名，修改前先看 backend/src/api/schemas.ts）。
type DynamicMetrics struct {
	CPU            CPUInfo               `json:"cpu"`
	Memory         MemoryInfo            `json:"memory"`
	Load           LoadInfo              `json:"load"`
	Disks          []DiskInfo            `json:"disks,omitempty"`
	Network        []NetworkInfo         `json:"network,omitempty"`
	Swap           *SwapInfo             `json:"swap,omitempty"`            // Swap 信息（取不到时省略）
	ProcessCount   int                   `json:"process_count,omitempty"`   // 进程数
	TCPConnections int                   `json:"tcp_connections,omitempty"` // TCP 连接数
	UDPConnections int                   `json:"udp_connections,omitempty"` // UDP 连接数
	Ping           map[string]PingResult `json:"ping,omitempty"`            // 四线路 TCP 拨测结果（ct/cu/cm/bd）
	IPv4Reachable  *bool                 `json:"ipv4_reachable,omitempty"`  // IPv4 出网可达性
	IPv6Reachable  *bool                 `json:"ipv6_reachable,omitempty"`  // IPv6 出网可达性
}

// SystemInfo 包含系统的各种信息
type SystemInfo struct {
	Token                  string    `json:"token"`
	Timestamp              time.Time `json:"timestamp"`
	Hostname               string    `json:"hostname"`
	Platform               string    `json:"platform"`
	OS                     string    `json:"os"`
	Version                string    `json:"version"`      // 操作系统版本
	IPAddresses            []string  `json:"ip_addresses"` // IP地址列表
	Keepalive              int       `json:"keepalive"`
	CollectIntervalSeconds int       `json:"collect_interval_seconds"`
	ReportIntervalSeconds  int       `json:"report_interval_seconds"`
	DynamicMetrics
	BootTime int64 `json:"boot_time,omitempty"` // 主机启动时间（Unix 秒）
}

// SwapInfo 包含 Swap 相关信息
type SwapInfo struct {
	Total     uint64  `json:"total"`
	Used      uint64  `json:"used"`
	UsageRate float64 `json:"usage_rate"`
}

// PingResult 单条线路 TCP 拨测结果（用 TCP 连接耗时代替 ICMP，避免 raw socket 权限）
type PingResult struct {
	Target    string  `json:"target"`
	LatencyMs float64 `json:"latency_ms"` // 丢包时为 -1
	Loss      bool    `json:"loss"`       // 超时/失败视为丢包
}

// Sample 为批量上报中的单个采集样本（只含动态指标，静态元数据由顶层承载）
type Sample struct {
	TS int64 `json:"ts"` // Unix 毫秒
	DynamicMetrics
}

// NewSample 从一次完整采集中抽取动态指标生成样本
func NewSample(info *SystemInfo) *Sample {
	return &Sample{
		TS:             info.Timestamp.UnixMilli(),
		DynamicMetrics: info.DynamicMetrics,
	}
}

// StatusReport 新协议上报体：顶层为最新一次采集（向后兼容旧服务端），
// samples 为整个上报窗口内的全部样本（旧服务端会忽略该未知字段）。
type StatusReport struct {
	*SystemInfo
	Samples []*Sample `json:"samples,omitempty"`
}

// CPUInfo 包含CPU相关信息
type CPUInfo struct {
	Usage     float64 `json:"usage"`
	Cores     int     `json:"cores"`
	ModelName string  `json:"model_name"`
}

// MemoryInfo 包含内存相关信息
type MemoryInfo struct {
	Total     uint64  `json:"total"`
	Used      uint64  `json:"used"`
	Free      uint64  `json:"free"`
	UsageRate float64 `json:"usage_rate"`
}

// DiskInfo 包含磁盘相关信息
type DiskInfo struct {
	Device     string  `json:"device"`
	MountPoint string  `json:"mount_point"`
	Total      uint64  `json:"total"`
	Used       uint64  `json:"used"`
	Free       uint64  `json:"free"`
	UsageRate  float64 `json:"usage_rate"`
	FSType     string  `json:"fs_type"`
}

// NetworkInfo 包含网络相关信息
type NetworkInfo struct {
	Interface   string `json:"interface"`
	BytesSent   uint64 `json:"bytes_sent"`
	BytesRecv   uint64 `json:"bytes_recv"`
	PacketsSent uint64 `json:"packets_sent"`
	PacketsRecv uint64 `json:"packets_recv"`
}

// LoadInfo 包含系统负载信息
type LoadInfo struct {
	Load1  float64 `json:"load1"`
	Load5  float64 `json:"load5"`
	Load15 float64 `json:"load15"`
}
