package model

import "time"

// SystemInfo 包含系统的各种信息
type SystemInfo struct {
	Token                  string        `json:"token"`
	Timestamp              time.Time     `json:"timestamp"`
	Hostname               string        `json:"hostname"`
	Platform               string        `json:"platform"`
	OS                     string        `json:"os"`
	Version                string        `json:"version"`      // 操作系统版本
	IPAddresses            []string      `json:"ip_addresses"` // IP地址列表
	Keepalive              int           `json:"keepalive"`
	CollectIntervalSeconds int           `json:"collect_interval_seconds"`
	ReportIntervalSeconds  int           `json:"report_interval_seconds"`
	CPUInfo                CPUInfo       `json:"cpu"`
	MemoryInfo             MemoryInfo    `json:"memory"`
	DiskInfo               []DiskInfo    `json:"disks"`
	NetworkInfo            []NetworkInfo `json:"network"`
	LoadInfo               LoadInfo      `json:"load"`
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
