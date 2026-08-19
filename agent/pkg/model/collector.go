package model

import "time"

// DynamicMetrics 每次采集都会变化的动态指标，由 SystemInfo 与 Sample 匿名内嵌共用。
// 内嵌时不带 json tag，字段在两者的 JSON 中平铺，字段名由此处的 tag 唯一决定
// （服务端 zod 依赖这些字段名，修改前先看 backend/src/modules/agents/http/schemas.ts）。
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
	AgentVersion           string    `json:"-"`
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

// AgentReportSample 是 v4 数据面的一条采样。时间使用带时区的 RFC3339，
// 其余动态指标与采集模型共用同一组字段定义。
type AgentReportSample struct {
	CollectedAt string `json:"collected_at"`
	DynamicMetrics
}

// AgentReportProtocolVersion 是当前数据面协议版本。
// v4 以逐条 JSON 样本上报，v5 改为列式压缩块，两者不兼容。
const AgentReportProtocolVersion = 5

// AgentReportBlock 是一个列式压缩的指标块。编码规格见 pkg/metricblock，
// 服务端按 (agent_id, resolution, bucket_start) 幂等 upsert。
type AgentReportBlock struct {
	// Resolution 为 1（1 秒块，桶跨 1 分钟）或 60（1 分钟聚合块，桶跨 1 小时）
	Resolution  int   `json:"resolution"`
	BucketStart int64 `json:"bucket_start"`
	// PointCount 是【实际存在】的槽数，服务端用它做单调守卫，
	// 与块头里恒为 60 的 slot_count 不是一回事。
	PointCount int    `json:"point_count"`
	Codec      int    `json:"codec"`
	Data       string `json:"data"` // base64 (std, 带 padding)
}

// AgentReport 是 v5 数据面持久化和传输的稳定信封。report_id 在本地 Spool
// 首次组批时生成，网络重试和进程重启后保持不变。
type AgentReport struct {
	ProtocolVersion       int                 `json:"protocol_version"`
	AgentVersion          string              `json:"agent_version,omitempty"`
	ReportID              string              `json:"report_id"`
	Hostname              string              `json:"hostname,omitempty"`
	IPAddresses           []string            `json:"ip_addresses,omitempty"`
	OS                    string              `json:"os,omitempty"`
	Version               string              `json:"version,omitempty"`
	BootTime              int64               `json:"boot_time,omitempty"`
	KeepaliveSeconds      int                 `json:"keepalive_seconds,omitempty"`
	ReportIntervalSeconds int                 `json:"report_interval_seconds,omitempty"`
	Blocks                []*AgentReportBlock `json:"blocks"`
	// Latest 是本批次最后一条原始样本，服务端据此更新 agent_current_metrics
	// 以及 CPU 型号、设备名等不进块的静态元数据。
	Latest *AgentReportSample `json:"latest,omitempty"`
}

// SampleCount 汇总本次上报覆盖的采样点数，仅用于日志。
func (r *AgentReport) SampleCount() int {
	total := 0
	for _, block := range r.Blocks {
		if block.Resolution == 1 {
			total += block.PointCount
		}
	}
	return total
}

// LiveMetricFrame 是 Agent 到 Worker 独立上行 WebSocket 的实时协议。
// 实时帧只承载指标，不携带 Agent Credential 和静态身份；身份在 WebSocket
// 握手阶段通过 Authorization Header 完成绑定。
type LiveMetricFrame struct {
	Type            string                `json:"type"`
	ProtocolVersion int                   `json:"protocol_version"`
	Sequence        uint64                `json:"sequence"`
	CollectedAt     string                `json:"collected_at"`
	CPU             CPUInfo               `json:"cpu"`
	Memory          MemoryInfo            `json:"memory"`
	Load            LoadInfo              `json:"load"`
	Disks           []DiskInfo            `json:"disks,omitempty"`
	Network         []NetworkInfo         `json:"network,omitempty"`
	Swap            *SwapInfo             `json:"swap,omitempty"`
	ProcessCount    int                   `json:"process_count,omitempty"`
	TCPConnections  int                   `json:"tcp_connections,omitempty"`
	UDPConnections  int                   `json:"udp_connections,omitempty"`
	Ping            map[string]PingResult `json:"ping,omitempty"`
	IPv4Reachable   *bool                 `json:"ipv4_reachable,omitempty"`
	IPv6Reachable   *bool                 `json:"ipv6_reachable,omitempty"`
	NetworkRxSpeed  *float64              `json:"network_rx_speed"`
	NetworkTxSpeed  *float64              `json:"network_tx_speed"`
}

// NewAgentReportSample 从一次完整采集中生成不含凭据的 v4 样本。
func NewAgentReportSample(info *SystemInfo) *AgentReportSample {
	return &AgentReportSample{
		CollectedAt:    info.Timestamp.UTC().Format(time.RFC3339Nano),
		DynamicMetrics: info.DynamicMetrics,
	}
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
