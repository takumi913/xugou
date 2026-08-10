package spool

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/xugou/agent/pkg/model"
)

func testInfo(timestamp time.Time, usage float64) *model.SystemInfo {
	return &model.SystemInfo{
		Token:                  "secret-must-not-be-persisted",
		Timestamp:              timestamp,
		Hostname:               "node-a",
		IPAddresses:            []string{"192.0.2.10"},
		OS:                     "linux",
		Version:                "test",
		BootTime:               123,
		Keepalive:              300,
		ReportIntervalSeconds:  300,
		CollectIntervalSeconds: 60,
		DynamicMetrics: model.DynamicMetrics{
			CPU:    model.CPUInfo{Usage: usage, Cores: 4, ModelName: "test"},
			Memory: model.MemoryInfo{Total: 100, Used: 50, Free: 50, UsageRate: 50},
			Load:   model.LoadInfo{Load1: 1, Load5: 1, Load15: 1},
		},
	}
}

func TestSpoolPersistsStableInflightAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(Options{Dir: dir, MaxBytes: 1024 * 1024, MaxEntries: 10})
	if err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 8, 2, 12, 0, 0, 0, time.UTC)
	for i := range 3 {
		if _, err := store.Add(testInfo(base.Add(time.Duration(i)*time.Minute), float64(i))); err != nil {
			t.Fatal(err)
		}
	}

	report, ok, err := store.Next(2, DefaultMaxCompressedBytes)
	if err != nil || !ok {
		t.Fatalf("创建批次失败: ok=%v err=%v", ok, err)
	}
	if len(report.Samples) != 2 {
		t.Fatalf("批次样本数=%d, want 2", len(report.Samples))
	}
	if report.ProtocolVersion != 4 {
		t.Fatalf("protocol_version=%d, want 4", report.ProtocolVersion)
	}
	firstID := report.ReportID

	reopened, err := Open(Options{Dir: dir, MaxBytes: 1024 * 1024, MaxEntries: 10})
	if err != nil {
		t.Fatal(err)
	}
	retry, ok, err := reopened.Next(2, DefaultMaxCompressedBytes)
	if err != nil || !ok {
		t.Fatalf("恢复 inflight 失败: ok=%v err=%v", ok, err)
	}
	if retry.ReportID != firstID {
		t.Fatalf("重启后 report_id 变化: got %q, want %q", retry.ReportID, firstID)
	}
	if err := reopened.Ack(firstID); err != nil {
		t.Fatal(err)
	}
	next, ok, err := reopened.Next(2, DefaultMaxCompressedBytes)
	if err != nil || !ok {
		t.Fatalf("读取剩余批次失败: ok=%v err=%v", ok, err)
	}
	if next.ReportID == firstID || len(next.Samples) != 1 {
		t.Fatalf("剩余批次异常: %+v", next)
	}
}

func TestSpoolNeverPersistsTokenAndUsesRestrictedPermissions(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(Options{Dir: dir, MaxBytes: 1024 * 1024, MaxEntries: 10})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Add(testInfo(time.Now(), 10)); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if stringContains(string(raw), "secret-must-not-be-persisted") || stringContains(string(raw), `"token"`) {
			t.Fatalf("spool 文件包含凭据: %s", entry.Name())
		}
		info, err := entry.Info()
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("文件权限=%o, want 600", info.Mode().Perm())
		}
	}
}

func TestSpoolBoundDropsOldestPendingButKeepsInflight(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(Options{Dir: dir, MaxBytes: 1024 * 1024, MaxEntries: 2})
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now().Add(-time.Hour)
	if _, err := store.Add(testInfo(base, 1)); err != nil {
		t.Fatal(err)
	}
	first, ok, err := store.Next(1, DefaultMaxCompressedBytes)
	if err != nil || !ok {
		t.Fatalf("创建 inflight 失败: %v", err)
	}
	for i := 1; i <= 3; i++ {
		if _, err := store.Add(testInfo(base.Add(time.Duration(i)*time.Second), float64(i))); err != nil {
			t.Fatal(err)
		}
	}
	stats, err := store.Stats()
	if err != nil {
		t.Fatal(err)
	}
	if stats.Samples != 2 || stats.DroppedSamples != 2 || !stats.Inflight {
		t.Fatalf("边界统计异常: %+v", stats)
	}
	retry, ok, err := store.Next(1, DefaultMaxCompressedBytes)
	if err != nil || !ok || retry.ReportID != first.ReportID {
		t.Fatalf("inflight 被边界清理破坏: report=%+v err=%v", retry, err)
	}
}

func TestSpoolRejectsAckForDifferentReport(t *testing.T) {
	store, err := Open(Options{Dir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Add(testInfo(time.Now(), 1)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Next(1, DefaultMaxCompressedBytes); err != nil {
		t.Fatal(err)
	}
	if err := store.Ack("00000000-0000-4000-8000-000000000000"); err == nil {
		t.Fatal("错误 report_id 的 ack 应失败")
	}
}

func TestSpoolRecoversCrashDuringTwoPhaseAck(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(Options{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Add(testInfo(time.Now(), 1)); err != nil {
		t.Fatal(err)
	}
	report, ok, err := store.Next(1, DefaultMaxCompressedBytes)
	if err != nil || !ok {
		t.Fatalf("创建 inflight 失败: %v", err)
	}
	// 模拟 Ack 已原子提交，但进程尚未删除源样本就退出。
	if err := os.Rename(
		filepath.Join(dir, inflightFileName),
		filepath.Join(dir, "acked-"+report.ReportID+".json"),
	); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(Options{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	stats, err := reopened.Stats()
	if err != nil {
		t.Fatal(err)
	}
	if stats.Samples != 0 || stats.Inflight {
		t.Fatalf("两阶段 Ack 恢复后仍有待发样本: %+v", stats)
	}
}

func stringContains(value, fragment string) bool {
	for i := 0; i+len(fragment) <= len(value); i++ {
		if value[i:i+len(fragment)] == fragment {
			return true
		}
	}
	return false
}
