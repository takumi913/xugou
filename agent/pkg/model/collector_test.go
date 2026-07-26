package model

import (
	"encoding/json"
	"sort"
	"testing"
	"time"
)

// fullSystemInfo 构造一个全部字段都有值的 SystemInfo，保证 omitempty 字段也会出现在 JSON 中
func fullSystemInfo() *SystemInfo {
	yes := true
	no := false
	return &SystemInfo{
		Token:                  "token",
		Timestamp:              time.Unix(1700000000, 0),
		Hostname:               "host",
		Platform:               "darwin",
		OS:                     "darwin",
		Version:                "macOS 14",
		IPAddresses:            []string{"10.0.0.1"},
		Keepalive:              300,
		CollectIntervalSeconds: 60,
		ReportIntervalSeconds:  300,
		DynamicMetrics: DynamicMetrics{
			CPU:    CPUInfo{Usage: 1.5, Cores: 8, ModelName: "test-cpu"},
			Memory: MemoryInfo{Total: 100, Used: 50, Free: 50, UsageRate: 50},
			Load:   LoadInfo{Load1: 1, Load5: 2, Load15: 3},
			Disks: []DiskInfo{
				{Device: "/dev/sda1", MountPoint: "/", Total: 10, Used: 5, Free: 5, UsageRate: 50, FSType: "ext4"},
			},
			Network: []NetworkInfo{
				{Interface: "eth0", BytesSent: 1, BytesRecv: 2, PacketsSent: 3, PacketsRecv: 4},
			},
			Swap:           &SwapInfo{Total: 10, Used: 1, UsageRate: 10},
			ProcessCount:   42,
			TCPConnections: 7,
			UDPConnections: 3,
			Ping: map[string]PingResult{
				"ct": {Target: "www.189.cn:443", LatencyMs: 12.3, Loss: false},
			},
			IPv4Reachable: &yes,
			IPv6Reachable: &no,
		},
		BootTime: 1690000000,
	}
}

// jsonKeys 返回 v 序列化后 JSON 对象的顶层键（排序后）
func jsonKeys(t *testing.T, v any) []string {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("反序列化失败: %v", err)
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func assertKeysEqual(t *testing.T, got, want []string) {
	t.Helper()
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("JSON 字段名集合与协议不一致:\n  实际: %v\n  期望: %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("JSON 字段名集合与协议不一致:\n  实际: %v\n  期望: %v", got, want)
		}
	}
}

// TestSystemInfoWireFieldNames 断言 SystemInfo 序列化后的顶层字段名集合与
// 服务端 zod schema（backend/src/api/schemas.ts agentStatusItemSchema）约定一致。
// 字段名硬编码，防止结构体重构导致 wire 格式漂移。
func TestSystemInfoWireFieldNames(t *testing.T) {
	assertKeysEqual(t, jsonKeys(t, fullSystemInfo()), []string{
		"token",
		"timestamp",
		"hostname",
		"platform",
		"os",
		"version",
		"ip_addresses",
		"keepalive",
		"collect_interval_seconds",
		"report_interval_seconds",
		"cpu",
		"memory",
		"load",
		"disks",
		"network",
		"swap",
		"boot_time",
		"process_count",
		"tcp_connections",
		"udp_connections",
		"ping",
		"ipv4_reachable",
		"ipv6_reachable",
	})
}

// TestSampleWireFieldNames 断言 Sample 序列化后的顶层字段名集合与
// 服务端 zod schema（agentStatusSampleSchema）约定一致。
func TestSampleWireFieldNames(t *testing.T) {
	assertKeysEqual(t, jsonKeys(t, NewSample(fullSystemInfo())), []string{
		"ts",
		"cpu",
		"memory",
		"load",
		"disks",
		"network",
		"swap",
		"process_count",
		"tcp_connections",
		"udp_connections",
		"ping",
		"ipv4_reachable",
		"ipv6_reachable",
	})
}

// TestNewSampleCopiesDynamicMetrics 断言 NewSample 完整拷贝动态指标并换算时间戳
func TestNewSampleCopiesDynamicMetrics(t *testing.T) {
	info := fullSystemInfo()
	sample := NewSample(info)
	if sample.TS != info.Timestamp.UnixMilli() {
		t.Fatalf("TS = %d, want %d", sample.TS, info.Timestamp.UnixMilli())
	}
	if sample.CPU != info.CPU || sample.Memory != info.Memory || sample.Load != info.Load {
		t.Fatal("NewSample 未完整拷贝动态指标")
	}
	if sample.ProcessCount != info.ProcessCount || sample.Swap != info.Swap {
		t.Fatal("NewSample 未完整拷贝动态指标")
	}
}
