package metricblock

import (
	"encoding/json"
	"math"
	"math/rand"
	"testing"
	"time"

	"github.com/xugou/agent/pkg/model"
)

// productionSampleJSON 取自线上 agent 38 的真实样本（2026-08-12T16:44:31Z），
// 用于把压缩比校准到真实数据而非合成序列。
const productionSampleJSON = `{
"collected_at":"2026-08-12T16:44:31.070Z",
"cpu":{"usage":8.90933585427149e-9,"cores":1,"model_name":"Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz"},
"memory":{"total":1008193536,"used":314904576,"free":161382400,"usage_rate":31.23453630236328},
"load":{"load1":0.65,"load5":0.7,"load15":0.4},
"disks":[
 {"device":"/dev/sda1","mount_point":"/","total":50884108288,"used":5971861504,"free":44895469568,"usage_rate":11.740072416119391,"fs_type":"ext4"},
 {"device":"/dev/sda16","mount_point":"/boot","total":923156480,"used":122167296,"free":736346112,"usage_rate":14.23009761543526,"fs_type":"ext4"},
 {"device":"/dev/sda15","mount_point":"/boot/efi","total":109395456,"used":6395392,"free":103000064,"usage_rate":5.846122164342914,"fs_type":"vfat"}],
"network":[
 {"interface":"lo","bytes_sent":50785014634,"bytes_recv":50785014634,"packets_sent":28167765,"packets_recv":28167765},
 {"interface":"enp1s0","bytes_sent":206873175400,"bytes_recv":214511837610,"packets_sent":164730011,"packets_recv":327148303},
 {"interface":"docker0","bytes_sent":0,"bytes_recv":0,"packets_sent":0,"packets_recv":0}],
"swap":{"total":1073737728,"used":113917952,"usage_rate":10.60947650709727},
"process_count":120,"tcp_connections":57,"udp_connections":10,
"ping":{
 "bd":{"target":"www.baidu.com:443","latency_ms":78.985,"loss":false},
 "cm":{"target":"www.10086.cn:443","latency_ms":54.459,"loss":false},
 "ct":{"target":"www.189.cn:443","latency_ms":115.68,"loss":false},
 "cu":{"target":"www.10010.com:443","latency_ms":5.718,"loss":false}},
"ipv4_reachable":true,"ipv6_reachable":false}`

func baseSample(t *testing.T) *model.AgentReportSample {
	t.Helper()
	var s model.AgentReportSample
	if err := json.Unmarshal([]byte(productionSampleJSON), &s); err != nil {
		t.Fatalf("解析生产样本失败: %v", err)
	}
	return &s
}

// syntheticMinute 基于真实样本生成一分钟（60 条）带真实抖动的样本序列。
// 计数器单调递增，比率类围绕基线随机游走 —— 刻意比正弦波更"毛糙"，
// 避免把压缩比测得过于乐观。
func syntheticMinute(t *testing.T, bucketStart int64) []*model.AgentReportSample {
	t.Helper()
	base := baseSample(t)
	rng := rand.New(rand.NewSource(42))
	out := make([]*model.AgentReportSample, 0, SlotsPerBlock)

	// 网络计数器必须单调递增（真实内核计数器就是如此）。用累积和而不是
	// base + step*i —— 后者每步重新随机 step 会让序列出现回退，既不真实，
	// 也会因 delta 变大而低估压缩比。
	cumSent := make([]uint64, len(base.Network))
	cumRecv := make([]uint64, len(base.Network))
	cumPktSent := make([]uint64, len(base.Network))
	cumPktRecv := make([]uint64, len(base.Network))

	for i := 0; i < SlotsPerBlock; i++ {
		raw, err := json.Marshal(base)
		if err != nil {
			t.Fatalf("克隆样本失败: %v", err)
		}
		var s model.AgentReportSample
		if err := json.Unmarshal(raw, &s); err != nil {
			t.Fatalf("克隆样本失败: %v", err)
		}
		ts := time.Unix(bucketStart+int64(i), 0).UTC()
		s.CollectedAt = ts.Format(time.RFC3339Nano)

		s.CPU.Usage = math.Abs(rng.NormFloat64()*8 + 12)
		s.Memory.Used = uint64(float64(base.Memory.Used) * (1 + rng.NormFloat64()*0.01))
		s.Memory.Free = base.Memory.Total - s.Memory.Used
		s.Load.Load1 = math.Abs(base.Load.Load1 + rng.NormFloat64()*0.1)
		s.ProcessCount = base.ProcessCount + rng.Intn(5) - 2
		s.TCPConnections = base.TCPConnections + rng.Intn(9) - 4
		for j := range s.Network {
			// 每秒新增量随机，但累积值单调不减
			cumSent[j] += uint64(rng.Intn(9000) + 500)
			cumRecv[j] += uint64(rng.Intn(18000) + 1000)
			cumPktSent[j] += uint64(rng.Intn(12) + 1)
			cumPktRecv[j] += uint64(rng.Intn(20) + 1)
			s.Network[j].BytesSent = base.Network[j].BytesSent + cumSent[j]
			s.Network[j].BytesRecv = base.Network[j].BytesRecv + cumRecv[j]
			s.Network[j].PacketsSent = base.Network[j].PacketsSent + cumPktSent[j]
			s.Network[j].PacketsRecv = base.Network[j].PacketsRecv + cumPktRecv[j]
		}
		for k, p := range s.Ping {
			p.LatencyMs = math.Abs(p.LatencyMs + rng.NormFloat64()*3)
			s.Ping[k] = p
		}
		out = append(out, &s)
	}
	return out
}

func TestEncodeDecodeRoundTrip(t *testing.T) {
	bucket := BucketStartFor(time.Now().Unix(), 1)
	samples := syntheticMinute(t, bucket)

	block, err := Encode(bucket, samples)
	if err != nil {
		t.Fatalf("编码失败: %v", err)
	}
	if block.Resolution != 1 || block.BucketStart != bucket {
		t.Fatalf("块元信息错误: %+v", block)
	}
	if block.PointCount != SlotsPerBlock {
		t.Fatalf("期望 %d 个点，实际 %d", SlotsPerBlock, block.PointCount)
	}

	decoded, err := Decode(block.Data)
	if err != nil {
		t.Fatalf("解码失败: %v", err)
	}
	if decoded.Interval != 1 || decoded.BucketStart != bucket {
		t.Fatalf("解码元信息错误: %+v", decoded)
	}
	if decoded.MemoryTotal != samples[0].Memory.Total {
		t.Fatalf("memory_total 不匹配: %d vs %d", decoded.MemoryTotal, samples[0].Memory.Total)
	}

	// 维度头顺序必须稳定（ping key 排序）
	wantPings := []string{"bd", "cm", "ct", "cu"}
	for i, want := range wantPings {
		if decoded.Dims.Pings[i] != want {
			t.Fatalf("ping slot %d 期望 %s，实际 %s", i, want, decoded.Dims.Pings[i])
		}
	}

	// 逐值比对，容差取定点精度的一半
	for slot, s := range samples {
		assertClose(t, decoded, SeriesCPUUsage, slot, s.CPU.Usage, 0.005)
		assertClose(t, decoded, SeriesMemoryUsed, slot, float64(s.Memory.Used), 0.5)
		assertClose(t, decoded, SeriesLoad1, slot, s.Load.Load1, 0.005)
		assertClose(t, decoded, SeriesProcessCount, slot, float64(s.ProcessCount), 0.5)
		assertClose(t, decoded, SeriesTCPConnections, slot, float64(s.TCPConnections), 0.5)
		for j := range s.Network {
			assertClose(t, decoded, NetSeriesID(j, NetFieldBytesSent), slot,
				float64(s.Network[j].BytesSent), 0.5)
			assertClose(t, decoded, NetSeriesID(j, NetFieldPacketsRecv), slot,
				float64(s.Network[j].PacketsRecv), 0.5)
		}
		for j, key := range decoded.Dims.Pings {
			assertClose(t, decoded, PingSeriesID(j, PingFieldLatencyMs), slot,
				s.Ping[key].LatencyMs, 0.0005)
		}
	}
}

func assertClose(t *testing.T, b *DecodedBlock, id uint16, slot int, want, tol float64) {
	t.Helper()
	aggs, ok := b.Series[id]
	if !ok {
		t.Fatalf("序列 %d 缺失", id)
	}
	got := aggs[0][slot]
	if got == nil {
		t.Fatalf("序列 %d 槽 %d 为空", id, slot)
	}
	if math.Abs(*got-want) > tol {
		t.Fatalf("序列 %d 槽 %d：期望 %v，实际 %v（容差 %v）", id, slot, want, *got, tol)
	}
}

// TestCompressionRatio 产出实测压缩比，用于校准设计文档 §1.1 的容量表。
func TestCompressionRatio(t *testing.T) {
	bucket := BucketStartFor(time.Now().Unix(), 1)
	samples := syntheticMinute(t, bucket)

	jsonBytes := 0
	for _, s := range samples {
		raw, err := json.Marshal(s)
		if err != nil {
			t.Fatalf("序列化失败: %v", err)
		}
		jsonBytes += len(raw)
	}

	block, err := Encode(bucket, samples)
	if err != nil {
		t.Fatalf("编码失败: %v", err)
	}

	perSample := float64(len(block.Data)) / float64(SlotsPerBlock)
	ratio := float64(jsonBytes) / float64(len(block.Data))

	// 1 分钟层：满 60 点的聚合块
	hour := BucketStartFor(time.Now().Unix(), 60)
	points := make([]*MinutePoint, 0, SlotsPerBlock)
	for m := 0; m < SlotsPerBlock; m++ {
		minute := hour + int64(m)*60
		if p := Aggregate(minute, syntheticMinute(t, minute)); p != nil {
			points = append(points, p)
		}
	}
	rollup, err := EncodeRollup(hour, points)
	if err != nil {
		t.Fatalf("聚合块编码失败: %v", err)
	}

	const agents = 40
	const mib = 1024 * 1024

	hotPerAgentDay := perSample * 86400               // 1 秒层：单机每天
	warmPerAgentDay := float64(len(rollup.Data)) * 24 // 1 分钟层：单机每天（24 个小时块）
	hotFleetDay := hotPerAgentDay * agents / mib
	warmFleet7d := warmPerAgentDay * agents * 7 / mib

	t.Logf("=== 1 秒层 ===")
	t.Logf("现状 JSON 逐行     : %d B (%.1f KB)", jsonBytes, float64(jsonBytes)/1024)
	t.Logf("块编码后           : %d B (%.1f KB)", len(block.Data), float64(len(block.Data))/1024)
	t.Logf("每样本等效         : %.1f B", perSample)
	t.Logf("压缩比             : %.1fx", ratio)
	t.Logf("单机每天           : %.2f MB", hotPerAgentDay/mib)
	t.Logf("%d 台每天          : %.1f MB", agents, hotFleetDay)
	t.Logf("=== 1 分钟层 ===")
	t.Logf("满 60 点聚合块     : %d B", len(rollup.Data))
	t.Logf("单机每天           : %.1f KB", warmPerAgentDay/1024)
	t.Logf("%d 台 × 7 天       : %.1f MB", agents, warmFleet7d)

	for _, budgetMiB := range []float64{150, 250, 300} {
		hours := budgetMiB * mib / (hotPerAgentDay * agents) * 24
		total := budgetMiB + warmFleet7d + 60 // +60MB 监控/状态页/索引/余量
		t.Logf("1 秒层预算 %3.0f MB  -> 覆盖 %5.1f 小时，库总占用 %5.1f MB (%.0f%%)",
			budgetMiB, hours, total, total/500*100)
	}

	baselineHours := 250 * mib / (hotPerAgentDay * agents) * 24
	if baselineHours < 24 {
		t.Errorf("250 MB 预算下 1 秒层仅覆盖 %.1f 小时，跌破 24 小时底线", baselineHours)
	}
}

func TestRollupRoundTrip(t *testing.T) {
	hour := BucketStartFor(time.Now().Unix(), 60)
	var points []*MinutePoint
	for m := 0; m < 5; m++ {
		minute := hour + int64(m)*60
		p := Aggregate(minute, syntheticMinute(t, minute))
		if p == nil {
			t.Fatalf("第 %d 分钟聚合返回 nil", m)
		}
		points = append(points, p)
	}

	block, err := EncodeRollup(hour, points)
	if err != nil {
		t.Fatalf("聚合块编码失败: %v", err)
	}
	if block.PointCount != 5 {
		t.Fatalf("期望 5 个点，实际 %d", block.PointCount)
	}

	decoded, err := Decode(block.Data)
	if err != nil {
		t.Fatalf("聚合块解码失败: %v", err)
	}
	if decoded.AggCount != 3 {
		t.Fatalf("期望 aggregate_count=3，实际 %d", decoded.AggCount)
	}

	for m, p := range points {
		want := p.Values[SeriesCPUUsage]
		for agg := 0; agg < 3; agg++ {
			got := decoded.Series[SeriesCPUUsage][agg][m]
			if got == nil {
				t.Fatalf("分钟 %d 聚合 %d 为空", m, agg)
			}
			if math.Abs(*got-want[agg]) > 0.005 {
				t.Fatalf("分钟 %d 聚合 %d：期望 %v，实际 %v", m, agg, want[agg], *got)
			}
		}
		// min <= avg <= max
		lo, avg, hi := want[AggMin], want[AggAvg], want[AggMax]
		if lo > avg || avg > hi {
			t.Fatalf("分钟 %d 聚合次序错误: min=%v avg=%v max=%v", m, lo, avg, hi)
		}
	}
}

// TestRollupCounterUsesLast 锁住"单调计数器取 last 而非 avg"这条规则：
// 取平均会让相邻分钟差分出的速率系统性偏小。
func TestRollupCounterUsesLast(t *testing.T) {
	minute := BucketStartFor(time.Now().Unix(), 1)
	samples := syntheticMinute(t, minute)
	p := Aggregate(minute, samples)
	if p == nil {
		t.Fatal("聚合返回 nil")
	}
	id := NetSeriesID(0, NetFieldBytesSent)
	got := p.Values[id]
	want := float64(samples[len(samples)-1].Network[0].BytesSent)
	for agg := 0; agg < 3; agg++ {
		if math.Abs(got[agg]-want) > 0.5 {
			t.Fatalf("计数器聚合位 %d 应为最后值 %v，实际 %v", agg, want, got[agg])
		}
	}
}

func TestMissingValuesUsePresenceBitmap(t *testing.T) {
	bucket := BucketStartFor(time.Now().Unix(), 1)
	samples := syntheticMinute(t, bucket)
	// 抽掉中间 20 条，模拟采集中断
	sparse := append(append([]*model.AgentReportSample{}, samples[:20]...), samples[40:]...)

	block, err := Encode(bucket, sparse)
	if err != nil {
		t.Fatalf("编码失败: %v", err)
	}
	if block.PointCount != 40 {
		t.Fatalf("期望 40 个点，实际 %d", block.PointCount)
	}
	decoded, err := Decode(block.Data)
	if err != nil {
		t.Fatalf("解码失败: %v", err)
	}
	for slot := 20; slot < 40; slot++ {
		if decoded.Series[SeriesCPUUsage][0][slot] != nil {
			t.Fatalf("槽 %d 应为缺失", slot)
		}
	}
	for _, slot := range []int{0, 19, 40, 59} {
		if decoded.Series[SeriesCPUUsage][0][slot] == nil {
			t.Fatalf("槽 %d 不应缺失", slot)
		}
	}
}

// TestPingLossNegativeLatency 锁住"用 presence bitmap 而非哨兵值"：
// 丢包时 latency_ms 的真实取值就是 -1，哨兵方案必然与之撞车。
func TestPingLossNegativeLatency(t *testing.T) {
	bucket := BucketStartFor(time.Now().Unix(), 1)
	samples := syntheticMinute(t, bucket)
	for _, s := range samples {
		s.Ping["ct"] = model.PingResult{Target: "www.189.cn:443", LatencyMs: -1, Loss: true}
	}
	block, err := Encode(bucket, samples)
	if err != nil {
		t.Fatalf("编码失败: %v", err)
	}
	decoded, err := Decode(block.Data)
	if err != nil {
		t.Fatalf("解码失败: %v", err)
	}
	slot := indexOf(decoded.Dims.Pings, "ct")
	if slot < 0 {
		t.Fatal("ct 线路缺失")
	}
	got := decoded.Series[PingSeriesID(slot, PingFieldLatencyMs)][0][0]
	if got == nil || math.Abs(*got-(-1)) > 0.0005 {
		t.Fatalf("丢包时 latency 应保真为 -1，实际 %v", got)
	}
	loss := decoded.Series[PingSeriesID(slot, PingFieldLoss)][0][0]
	if loss == nil || *loss != 1 {
		t.Fatalf("loss 应为 1，实际 %v", loss)
	}
}

func TestSingleSampleBlock(t *testing.T) {
	bucket := BucketStartFor(time.Now().Unix(), 1)
	samples := syntheticMinute(t, bucket)[:1]
	block, err := Encode(bucket, samples)
	if err != nil {
		t.Fatalf("单点块编码失败: %v", err)
	}
	if block.PointCount != 1 {
		t.Fatalf("期望 1 个点，实际 %d", block.PointCount)
	}
	if _, err := Decode(block.Data); err != nil {
		t.Fatalf("单点块解码失败: %v", err)
	}
}

func TestTopologyChangeMidBlock(t *testing.T) {
	bucket := BucketStartFor(time.Now().Unix(), 1)
	samples := syntheticMinute(t, bucket)
	// 前 30 条少一块盘：维度头以最后一条为准，前半段该盘应为缺失
	for i := 0; i < 30; i++ {
		samples[i].Disks = samples[i].Disks[:2]
	}
	block, err := Encode(bucket, samples)
	if err != nil {
		t.Fatalf("编码失败: %v", err)
	}
	decoded, err := Decode(block.Data)
	if err != nil {
		t.Fatalf("解码失败: %v", err)
	}
	if len(decoded.Dims.Disks) != 3 {
		t.Fatalf("维度头应含 3 块盘，实际 %d", len(decoded.Dims.Disks))
	}
	third := decoded.Series[DiskSeriesID(2)][0]
	if third[0] != nil {
		t.Fatal("拓扑变化前的槽位应为缺失")
	}
	if third[59] == nil {
		t.Fatal("拓扑变化后的槽位不应缺失")
	}
}

func TestEmptySamplesRejected(t *testing.T) {
	if _, err := Encode(0, nil); err == nil {
		t.Fatal("空样本应返回错误")
	}
	if _, err := EncodeRollup(0, nil); err == nil {
		t.Fatal("空聚合点应返回错误")
	}
}

func TestDecodeRejectsMalformedInput(t *testing.T) {
	bucket := BucketStartFor(time.Now().Unix(), 1)
	valid, err := Encode(bucket, syntheticMinute(t, bucket))
	if err != nil {
		t.Fatalf("编码失败: %v", err)
	}

	cases := []struct {
		name   string
		mutate func([]byte) []byte
	}{
		{"空输入", func([]byte) []byte { return nil }},
		{"仅块头", func(b []byte) []byte { return b[:HeaderSize] }},
		{"块头被截断", func(b []byte) []byte { return b[:HeaderSize-1] }},
		{"magic 错误", func(b []byte) []byte { c := clone(b); c[0] = 0xFF; return c }},
		{"codec 版本错误", func(b []byte) []byte { c := clone(b); c[1] = 9; return c }},
		{"interval 非法", func(b []byte) []byte { c := clone(b); c[2] = 7; return c }},
		{"aggregate_count 非法", func(b []byte) []byte { c := clone(b); c[4] = 2; return c }},
		{"slot_count 为 0", func(b []byte) []byte {
			c := clone(b)
			c[8], c[9] = 0, 0
			return c
		}},
		{"series_count 超上限", func(b []byte) []byte {
			c := clone(b)
			c[6], c[7] = 0xFF, 0xFF
			return c
		}},
		{"尾部被截断", func(b []byte) []byte { return b[:len(b)-5] }},
		{"gzip 载荷损坏", func(b []byte) []byte {
			c := clone(b)
			c[len(c)-1] ^= 0xFF
			return c
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("解码器 panic 而非返回错误: %v", r)
				}
			}()
			if _, err := Decode(tc.mutate(valid.Data)); err == nil {
				t.Fatal("畸形输入应返回错误")
			}
		})
	}
}

func clone(b []byte) []byte {
	c := make([]byte, len(b))
	copy(c, b)
	return c
}

func TestBucketStartFor(t *testing.T) {
	cases := []struct {
		ts       int64
		interval int
		want     int64
	}{
		{1000000000, 1, 999999960},  // 对齐到分钟
		{1000000000, 60, 999997200}, // 对齐到小时
		{0, 1, 0},
		{59, 1, 0},
		{60, 1, 60},
	}
	for _, c := range cases {
		if got := BucketStartFor(c.ts, c.interval); got != c.want {
			t.Fatalf("BucketStartFor(%d, %d) = %d，期望 %d", c.ts, c.interval, got, c.want)
		}
	}
}

func TestVarintRoundTrip(t *testing.T) {
	values := []int64{0, 1, -1, 63, -64, 127, -128, math.MaxInt32, math.MinInt32,
		math.MaxInt64, math.MinInt64}
	for _, v := range values {
		buf := appendZigzag(nil, v)
		got, off, err := readZigzag(buf, 0)
		if err != nil {
			t.Fatalf("readZigzag(%d) 出错: %v", v, err)
		}
		if got != v {
			t.Fatalf("varint 往返失败: %d -> %d", v, got)
		}
		if off != len(buf) {
			t.Fatalf("varint 长度不符: %d vs %d", off, len(buf))
		}
	}
}
