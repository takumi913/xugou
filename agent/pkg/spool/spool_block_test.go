package spool

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/xugou/agent/pkg/metricblock"
	"github.com/xugou/agent/pkg/model"
)

// anchor 固定在一个整分钟起点，方便按秒偏移构造样本。
const anchor int64 = 1786000020 // 落在某分钟的第 20 秒之前对齐后使用

func minuteStart(offsetMinutes int64) int64 {
	return metricblock.BucketStartFor(anchor, 1) + offsetMinutes*60
}

func newStore(t *testing.T, now time.Time) *Store {
	t.Helper()
	store, err := Open(Options{Dir: t.TempDir()})
	if err != nil {
		t.Fatalf("打开 spool 失败: %v", err)
	}
	store.now = func() time.Time { return now }
	return store
}

func sampleAt(unix int64) *model.SystemInfo {
	ts := time.Unix(unix, 0).UTC()
	swap := &model.SwapInfo{Total: 1 << 30, Used: 1 << 28}
	return &model.SystemInfo{
		Hostname:     "test-host",
		OS:           "linux",
		Version:      "1.0",
		Keepalive:    60,
		Timestamp:    ts,
		AgentVersion: "v1.2.9",
		DynamicMetrics: model.DynamicMetrics{
			CPU:    model.CPUInfo{Usage: 12.5, Cores: 2, ModelName: "test-cpu"},
			Memory: model.MemoryInfo{Total: 1 << 31, Used: 1 << 29, Free: 1 << 30},
			Load:   model.LoadInfo{Load1: 0.5, Load5: 0.4, Load15: 0.3},
			Disks: []model.DiskInfo{
				{Device: "/dev/sda1", MountPoint: "/", Total: 1 << 40, Used: 1 << 38, FSType: "ext4"},
			},
			Network: []model.NetworkInfo{
				{Interface: "eth0", BytesSent: uint64(unix) * 1000, BytesRecv: uint64(unix) * 2000},
			},
			Swap:           swap,
			ProcessCount:   100,
			TCPConnections: 20,
			UDPConnections: 5,
		},
	}
}

func addRange(t *testing.T, store *Store, start int64, count int) {
	t.Helper()
	for i := 0; i < count; i++ {
		if _, err := store.Add(sampleAt(start + int64(i))); err != nil {
			t.Fatalf("写入样本失败: %v", err)
		}
	}
}

func blocksByResolution(report *model.AgentReport, resolution int) []*model.AgentReportBlock {
	var out []*model.AgentReportBlock
	for _, b := range report.Blocks {
		if b.Resolution == resolution {
			out = append(out, b)
		}
	}
	return out
}

func decodeReportBlock(t *testing.T, block *model.AgentReportBlock) *metricblock.DecodedBlock {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(block.Data)
	if err != nil {
		t.Fatalf("base64 解码失败: %v", err)
	}
	decoded, err := metricblock.Decode(raw)
	if err != nil {
		t.Fatalf("块解码失败: %v", err)
	}
	return decoded
}

// TestNextSkipsIncompleteBucket 锁住"只发已完整的分钟桶"这条规则：
// 当前分钟仍在写入，先发半个块会导致下一轮再发一次完整块，白白多写。
func TestNextSkipsIncompleteBucket(t *testing.T) {
	m0 := minuteStart(0)
	// 时钟停在 m0 这一分钟内 —— 该桶尚未完整
	store := newStore(t, time.Unix(m0+30, 0))
	addRange(t, store, m0, 30)

	report, ok, err := store.Next(DefaultMaxSamples, DefaultMaxCompressedBytes)
	if err != nil {
		t.Fatalf("Next 出错: %v", err)
	}
	if ok || report != nil {
		t.Fatalf("当前分钟未完整，不应组批，实际返回 %+v", report)
	}

	// 时钟推进到下一分钟，桶完整了
	store.now = func() time.Time { return time.Unix(m0+60, 0) }
	report, ok, err = store.Next(DefaultMaxSamples, DefaultMaxCompressedBytes)
	if err != nil {
		t.Fatalf("Next 出错: %v", err)
	}
	if !ok || report == nil {
		t.Fatal("桶完整后应能组批")
	}
	hot := blocksByResolution(report, 1)
	if len(hot) != 1 {
		t.Fatalf("期望 1 个 1 秒块，实际 %d", len(hot))
	}
	if hot[0].BucketStart != m0 {
		t.Fatalf("桶起点应为 %d，实际 %d", m0, hot[0].BucketStart)
	}
	if hot[0].PointCount != 30 {
		t.Fatalf("期望 30 个点，实际 %d", hot[0].PointCount)
	}
}

func TestNextGroupsMultipleBuckets(t *testing.T) {
	m0 := minuteStart(0)
	store := newStore(t, time.Unix(m0+180, 0))
	addRange(t, store, m0, 60)     // 第 0 分钟满
	addRange(t, store, m0+60, 60)  // 第 1 分钟满
	addRange(t, store, m0+120, 10) // 第 2 分钟部分（但已完整，因为时钟在第 3 分钟）

	report, ok, err := store.Next(DefaultMaxSamples, 1<<20)
	if err != nil || !ok {
		t.Fatalf("Next 失败: ok=%v err=%v", ok, err)
	}
	hot := blocksByResolution(report, 1)
	if len(hot) != 2 {
		t.Fatalf("maxSamples=100 应覆盖 2 个完整桶，实际 %d 个", len(hot))
	}
	if hot[0].BucketStart != m0 || hot[1].BucketStart != m0+60 {
		t.Fatalf("桶顺序错误: %d, %d", hot[0].BucketStart, hot[1].BucketStart)
	}
	// 关键：第二个桶必须完整发出 60 点，而不是被 maxSamples 截断成 40 点
	if hot[0].PointCount != 60 || hot[1].PointCount != 60 {
		t.Fatalf("桶应完整不被截断，实际点数: %d, %d", hot[0].PointCount, hot[1].PointCount)
	}
}

// TestBucketsAreAtomic 是上面那条规则的回归测试。
//
// 若 collectBuckets 按样本数硬性截断，第二个桶会只发 40 点，Ack 删掉这 40 条后，
// 剩余 20 条在下一轮组成同一桶的 20 点块 —— 服务端的单调守卫
// (excluded.point_count >= 现有值) 会拒绝它，这 20 秒数据永久丢失。
func TestBucketsAreAtomic(t *testing.T) {
	m0 := minuteStart(0)
	store := newStore(t, time.Unix(m0+180, 0))
	addRange(t, store, m0, 60)
	addRange(t, store, m0+60, 60)

	// 故意把上限设成 70：既不足以容纳两个完整桶，也会诱发半桶截断
	report, ok, err := store.Next(70, 1<<20)
	if err != nil || !ok {
		t.Fatalf("Next 失败: ok=%v err=%v", ok, err)
	}
	hot := blocksByResolution(report, 1)
	for _, block := range hot {
		if block.PointCount != 60 {
			t.Fatalf("桶 %d 被截断成 %d 点，会导致数据永久丢失",
				block.BucketStart, block.PointCount)
		}
	}

	// Ack 后剩余样本必须仍能组成完整的桶
	if err := store.Ack(report.ReportID); err != nil {
		t.Fatalf("Ack 失败: %v", err)
	}
	seen := map[int64]int{}
	for _, block := range hot {
		seen[block.BucketStart] = block.PointCount
	}
	for {
		next, ok, err := store.Next(70, 1<<20)
		if err != nil {
			t.Fatalf("后续 Next 失败: %v", err)
		}
		if !ok {
			break
		}
		for _, block := range blocksByResolution(next, 1) {
			if prev, dup := seen[block.BucketStart]; dup {
				t.Fatalf("桶 %d 被重复发送（先 %d 点，后 %d 点），说明发生了截断",
					block.BucketStart, prev, block.PointCount)
			}
			seen[block.BucketStart] = block.PointCount
		}
		if err := store.Ack(next.ReportID); err != nil {
			t.Fatalf("Ack 失败: %v", err)
		}
	}
	if len(seen) != 2 {
		t.Fatalf("应恰好发出 2 个桶，实际 %d 个", len(seen))
	}
	for start, count := range seen {
		if count != 60 {
			t.Fatalf("桶 %d 只发了 %d 点", start, count)
		}
	}
}

// TestRollupBlockGrowsAcrossReports 验证 1 分钟聚合块随轮次累积变长，
// 且服务端可以靠 point_count 单调递增来接受更完整的版本。
func TestRollupBlockGrowsAcrossReports(t *testing.T) {
	m0 := minuteStart(0)
	store := newStore(t, time.Unix(m0+60, 0))

	addRange(t, store, m0, 60)
	report, ok, err := store.Next(DefaultMaxSamples, 1<<20)
	if err != nil || !ok {
		t.Fatalf("首轮 Next 失败: ok=%v err=%v", ok, err)
	}
	rollup := blocksByResolution(report, 60)
	if len(rollup) != 1 {
		t.Fatalf("期望 1 个聚合块，实际 %d", len(rollup))
	}
	if rollup[0].PointCount != 1 {
		t.Fatalf("首轮聚合块应含 1 个分钟点，实际 %d", rollup[0].PointCount)
	}
	firstHour := rollup[0].BucketStart
	if firstHour != metricblock.BucketStartFor(m0, 60) {
		t.Fatalf("聚合块应按小时对齐，实际 %d", firstHour)
	}
	if err := store.Ack(report.ReportID); err != nil {
		t.Fatalf("Ack 失败: %v", err)
	}

	// 第二轮：再加一分钟，聚合块应变成 2 个点且小时桶不变
	store.now = func() time.Time { return time.Unix(m0+120, 0) }
	addRange(t, store, m0+60, 60)
	report, ok, err = store.Next(DefaultMaxSamples, 1<<20)
	if err != nil || !ok {
		t.Fatalf("次轮 Next 失败: ok=%v err=%v", ok, err)
	}
	rollup = blocksByResolution(report, 60)
	if len(rollup) != 1 {
		t.Fatalf("期望 1 个聚合块，实际 %d", len(rollup))
	}
	if rollup[0].BucketStart != firstHour {
		t.Fatalf("仍在同一小时，桶起点不应变化")
	}
	if rollup[0].PointCount != 2 {
		t.Fatalf("次轮聚合块应含 2 个分钟点，实际 %d", rollup[0].PointCount)
	}

	decoded := decodeReportBlock(t, rollup[0])
	if decoded.AggCount != 3 {
		t.Fatalf("聚合块应有 3 个聚合位，实际 %d", decoded.AggCount)
	}
	if decoded.Interval != 60 {
		t.Fatalf("聚合块 interval 应为 60，实际 %d", decoded.Interval)
	}
}

// TestRollupPrunesPreviousHour 验证跨小时后旧小时的点被清理，
// 否则累积器会随运行时长无限增长。
func TestRollupPrunesPreviousHour(t *testing.T) {
	hour0 := metricblock.BucketStartFor(anchor, 60)
	lastMinute := hour0 + 59*60
	store := newStore(t, time.Unix(lastMinute+60, 0))

	addRange(t, store, lastMinute, 10)
	report, ok, err := store.Next(DefaultMaxSamples, 1<<20)
	if err != nil || !ok {
		t.Fatalf("首轮 Next 失败: ok=%v err=%v", ok, err)
	}
	if err := store.Ack(report.ReportID); err != nil {
		t.Fatalf("Ack 失败: %v", err)
	}
	if len(store.rollupPoints) != 1 {
		t.Fatalf("首轮后累积器应有 1 个点，实际 %d", len(store.rollupPoints))
	}

	// 跨到下一个小时
	nextHourMinute := hour0 + 3600
	store.now = func() time.Time { return time.Unix(nextHourMinute+60, 0) }
	addRange(t, store, nextHourMinute, 10)
	report, ok, err = store.Next(DefaultMaxSamples, 1<<20)
	if err != nil || !ok {
		t.Fatalf("次轮 Next 失败: ok=%v err=%v", ok, err)
	}
	rollup := blocksByResolution(report, 60)
	if len(rollup) != 2 {
		t.Fatalf("跨小时时应同时发出两个小时的聚合块，实际 %d", len(rollup))
	}
	if rollup[0].BucketStart != hour0 || rollup[1].BucketStart != hour0+3600 {
		t.Fatalf("聚合块小时顺序错误: %d, %d", rollup[0].BucketStart, rollup[1].BucketStart)
	}
	// 旧小时已完整，不应继续留在累积器里
	if len(store.rollupPoints) != 1 {
		t.Fatalf("跨小时后累积器应只剩当前小时的 1 个点，实际 %d", len(store.rollupPoints))
	}
	for minute := range store.rollupPoints {
		if metricblock.BucketStartFor(minute, 60) != hour0+3600 {
			t.Fatalf("累积器残留了旧小时的点: %d", minute)
		}
	}
}

// TestCorruptSampleDoesNotWedgeQueue 验证时间戳无法解析的样本文件仍会被
// 纳入 Ack 范围删除，否则一个坏文件会永久堵住队列。
func TestCorruptSampleDoesNotWedgeQueue(t *testing.T) {
	m0 := minuteStart(0)
	store := newStore(t, time.Unix(m0+60, 0))
	addRange(t, store, m0, 5)

	// 挑一个样本文件，把 collected_at 改成非法值
	files, err := store.sampleFiles()
	if err != nil {
		t.Fatalf("列出样本失败: %v", err)
	}
	if len(files) == 0 {
		t.Fatal("样本文件为空")
	}
	victim := filepath.Join(store.dir, files[0])
	raw, err := os.ReadFile(victim)
	if err != nil {
		t.Fatalf("读取样本失败: %v", err)
	}
	broken := replaceFirst(string(raw), `"collected_at":"`, `"collected_at":"NOT-A-TIME`)
	if err := os.WriteFile(victim, []byte(broken), 0o600); err != nil {
		t.Fatalf("写入损坏样本失败: %v", err)
	}

	report, ok, err := store.Next(DefaultMaxSamples, 1<<20)
	if err != nil {
		t.Fatalf("Next 不应因损坏样本而失败: %v", err)
	}
	if !ok {
		t.Fatal("其余样本仍应能组批")
	}
	if err := store.Ack(report.ReportID); err != nil {
		t.Fatalf("Ack 失败: %v", err)
	}

	remaining, err := store.sampleFiles()
	if err != nil {
		t.Fatalf("列出样本失败: %v", err)
	}
	if len(remaining) != 0 {
		t.Fatalf("Ack 后队列应清空（含损坏文件），实际剩 %d 个", len(remaining))
	}
}

func replaceFirst(s, old, new string) string {
	idx := indexOf(s, old)
	if idx < 0 {
		return s
	}
	return s[:idx] + new + s[idx+len(old):]
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

// TestInflightSurvivesRestart 验证已固化的批次在重启后原样重发，
// report_id 与块内容都不变。
func TestInflightSurvivesRestart(t *testing.T) {
	m0 := minuteStart(0)
	dir := t.TempDir()

	store, err := Open(Options{Dir: dir})
	if err != nil {
		t.Fatalf("打开 spool 失败: %v", err)
	}
	store.now = func() time.Time { return time.Unix(m0+60, 0) }
	addRange(t, store, m0, 60)

	first, ok, err := store.Next(DefaultMaxSamples, 1<<20)
	if err != nil || !ok {
		t.Fatalf("首次 Next 失败: ok=%v err=%v", ok, err)
	}

	// 模拟进程重启：重新 Open 同一目录，不 Ack
	reopened, err := Open(Options{Dir: dir})
	if err != nil {
		t.Fatalf("重开 spool 失败: %v", err)
	}
	reopened.now = func() time.Time { return time.Unix(m0+120, 0) }

	second, ok, err := reopened.Next(DefaultMaxSamples, 1<<20)
	if err != nil || !ok {
		t.Fatalf("重启后 Next 失败: ok=%v err=%v", ok, err)
	}
	if second.ReportID != first.ReportID {
		t.Fatalf("重启后 report_id 应保持不变: %s vs %s", first.ReportID, second.ReportID)
	}
	firstHot := blocksByResolution(first, 1)
	secondHot := blocksByResolution(second, 1)
	if len(firstHot) != len(secondHot) {
		t.Fatalf("重启后块数变化: %d vs %d", len(firstHot), len(secondHot))
	}
	if firstHot[0].Data != secondHot[0].Data {
		t.Fatal("重启后块内容应逐字节不变")
	}
}
