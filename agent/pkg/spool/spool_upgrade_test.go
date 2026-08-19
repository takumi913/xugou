package spool

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// v4 的 inflight manifest：上报体里是 `samples` 而不是 v5 的 `blocks`。
// v5 的严格解码器（DisallowUnknownFields）会拒绝它。
const legacyV4Inflight = `{
  "files": ["sample-0000000001.json"],
  "report": {
    "protocol_version": 4,
    "report_id": "aa8cdaaf-3515-42bc-8962-bda3446a1ea4",
    "hostname": "legacy-host",
    "samples": [{"collected_at": "2026-08-19T10:00:00Z", "metrics": {}}]
  }
}`

func writeFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
		t.Fatalf("写入 %s 失败: %v", name, err)
	}
}

// TestOpenDiscardsLegacyInflight 是 v4 → v5 升级路径的回归测试。
//
// 线上实测过的故障：升级后探针启动即失败于
// "读取 spool inflight 失败: json: unknown field \"samples\""，
// 服务反复退出，一条数据都上不来。任何带非空 spool 的存量探针都会中招。
func TestOpenDiscardsLegacyInflight(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, inflightFileName, legacyV4Inflight)

	store, err := Open(Options{Dir: dir})
	if err != nil {
		t.Fatalf("残留 v4 inflight 不应让 Open 失败: %v", err)
	}
	discarded := store.Discarded()
	if len(discarded) != 1 || discarded[0] != inflightFileName {
		t.Fatalf("应丢弃 inflight.json，实际 %v", discarded)
	}
	if _, err := os.Stat(filepath.Join(dir, inflightFileName)); !os.IsNotExist(err) {
		t.Fatalf("不兼容的 inflight 应被删除，stat err=%v", err)
	}
}

// 结构不兼容的样本文件同样不该拖垮启动。
func TestOpenDiscardsLegacySamples(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "sample-0000000001.json", `{"hostname":"h","legacy_only_field":1,"sample":{}}`)

	store, err := Open(Options{Dir: dir})
	if err != nil {
		t.Fatalf("残留 v4 样本不应让 Open 失败: %v", err)
	}
	if len(store.Discarded()) != 1 {
		t.Fatalf("应丢弃 1 个样本文件，实际 %v", store.Discarded())
	}
}

// 丢掉 inflight 后，仍然可解析的样本必须留下来重新组批——不能连数据一起删。
func TestOpenKeepsUsableSamplesAfterDiscardingInflight(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(Options{Dir: dir})
	if err != nil {
		t.Fatalf("打开 spool 失败: %v", err)
	}
	base := minuteStart(0)
	for i := 0; i < 60; i++ {
		if _, err := store.Add(sampleAt(base + int64(i))); err != nil {
			t.Fatalf("写入样本失败: %v", err)
		}
	}
	// 模拟升级：把 v4 的 manifest 塞回去，再重新 Open 同一个目录
	writeFile(t, dir, inflightFileName, legacyV4Inflight)

	reopened, err := Open(Options{Dir: dir})
	if err != nil {
		t.Fatalf("重新打开 spool 失败: %v", err)
	}
	if len(reopened.Discarded()) != 1 {
		t.Fatalf("只应丢弃 manifest，实际 %v", reopened.Discarded())
	}
	reopened.now = func() time.Time { return time.Unix(base+180, 0).UTC() }

	report, ok, err := reopened.Next(DefaultMaxSamples, 1<<20)
	if err != nil || !ok {
		t.Fatalf("样本应能重新组批: ok=%v err=%v", ok, err)
	}
	hot := blocksByResolution(report, 1)
	if len(hot) != 1 || hot[0].PointCount != 60 {
		t.Fatalf("应重新产出一个满 60 点的块，实际 %+v", hot)
	}
}

// 正常的 v5 spool 不应被误伤。
func TestOpenKeepsCompatibleFiles(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(Options{Dir: dir})
	if err != nil {
		t.Fatalf("打开 spool 失败: %v", err)
	}
	base := minuteStart(0)
	for i := 0; i < 10; i++ {
		if _, err := store.Add(sampleAt(base + int64(i))); err != nil {
			t.Fatalf("写入样本失败: %v", err)
		}
	}
	reopened, err := Open(Options{Dir: dir})
	if err != nil {
		t.Fatalf("重新打开 spool 失败: %v", err)
	}
	if len(reopened.Discarded()) != 0 {
		t.Fatalf("兼容文件不应被丢弃，实际 %v", reopened.Discarded())
	}
	stats, err := reopened.Stats()
	if err != nil {
		t.Fatalf("读取 spool 统计失败: %v", err)
	}
	if stats.Samples != 10 {
		t.Fatalf("样本应全部保留，实际 %d", stats.Samples)
	}
}
