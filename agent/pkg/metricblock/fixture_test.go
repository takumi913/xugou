package metricblock

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/xugou/agent/pkg/model"
)

// fixturePath 是 TS 侧往返测试读取的 fixture 位置。
const fixturePath = "../../../backend/src/modules/agents/metricblock/__fixtures__/blocks.json"

type fixtureDims struct {
	Disks []DiskDim `json:"disks"`
	Nets  []string  `json:"nets"`
	Pings []string  `json:"pings"`
}

type fixtureExpect struct {
	Interval    int                     `json:"interval"`
	BucketStart int64                   `json:"bucketStart"`
	SlotCount   int                     `json:"slotCount"`
	AggCount    int                     `json:"aggregateCount"`
	MemoryTotal uint64                  `json:"memoryTotal"`
	SwapTotal   uint64                  `json:"swapTotal"`
	Dims        fixtureDims             `json:"dims"`
	Series      map[string][][]*float64 `json:"series"`
}

type fixtureCase struct {
	Name       string        `json:"name"`
	Data       string        `json:"data"`
	PointCount int           `json:"pointCount"`
	Expect     fixtureExpect `json:"expect"`
}

// TestGenerateFixtures 把 Go 编码器的输出连同期望值写盘，供 TS 解码器做
// 跨语言往返比对。两端注册表一旦漂移，TS 测试立刻失败。
//
// 运行 `go test ./pkg/metricblock/` 即会刷新 fixture。
func TestGenerateFixtures(t *testing.T) {
	// 固定时间戳，保证 fixture 可复现（否则每次运行都产生 diff）
	const anchor = 1786000000 // 2026-08-05T14:26:40Z 附近
	bucket := BucketStartFor(anchor, 1)
	hour := BucketStartFor(anchor, 60)

	cases := []fixtureCase{}

	add := func(name string, block *Block) {
		decoded, err := Decode(block.Data)
		if err != nil {
			t.Fatalf("%s: 自解码失败 %v", name, err)
		}
		series := make(map[string][][]*float64, len(decoded.Series))
		for id, aggs := range decoded.Series {
			series[itoa(id)] = aggs
		}
		cases = append(cases, fixtureCase{
			Name:       name,
			Data:       base64.StdEncoding.EncodeToString(block.Data),
			PointCount: block.PointCount,
			Expect: fixtureExpect{
				Interval:    decoded.Interval,
				BucketStart: decoded.BucketStart,
				SlotCount:   decoded.SlotCount,
				AggCount:    decoded.AggCount,
				MemoryTotal: decoded.MemoryTotal,
				SwapTotal:   decoded.SwapTotal,
				Dims: fixtureDims{
					Disks: decoded.Dims.Disks,
					Nets:  decoded.Dims.Nets,
					Pings: decoded.Dims.Pings,
				},
				Series: series,
			},
		})
	}

	// 1) 稠密 1 秒块：60 槽全满，不带 presence bitmap
	dense := syntheticMinute(t, bucket)
	block, err := Encode(bucket, dense)
	if err != nil {
		t.Fatalf("稠密块编码失败: %v", err)
	}
	add("dense-1s", block)

	// 2) 稀疏 1 秒块：中间缺 20 槽，走 presence bitmap 路径
	sparse := append(append([]*model.AgentReportSample{}, dense[:20]...), dense[40:]...)
	block, err = Encode(bucket, sparse)
	if err != nil {
		t.Fatalf("稀疏块编码失败: %v", err)
	}
	add("sparse-1s", block)

	// 3) 单点块：边界
	block, err = Encode(bucket, dense[:1])
	if err != nil {
		t.Fatalf("单点块编码失败: %v", err)
	}
	add("single-point-1s", block)

	// 4) 丢包块：latency 为 -1 的负值必须保真（验证未用哨兵值）
	lossy := syntheticMinute(t, bucket)
	for _, s := range lossy {
		s.Ping["ct"] = model.PingResult{Target: "www.189.cn:443", LatencyMs: -1, Loss: true}
	}
	block, err = Encode(bucket, lossy)
	if err != nil {
		t.Fatalf("丢包块编码失败: %v", err)
	}
	add("ping-loss-1s", block)

	// 5) 1 分钟聚合块：aggregate_count=3
	var points []*MinutePoint
	for m := 0; m < 12; m++ {
		minute := hour + int64(m)*60
		if p := Aggregate(minute, syntheticMinute(t, minute)); p != nil {
			points = append(points, p)
		}
	}
	block, err = EncodeRollup(hour, points)
	if err != nil {
		t.Fatalf("聚合块编码失败: %v", err)
	}
	add("rollup-60s", block)

	payload := map[string]any{
		"_comment": "由 agent/pkg/metricblock/fixture_test.go 生成，请勿手改。" +
			"运行 `cd agent && go test ./pkg/metricblock/` 刷新。",
		"codecVersion": CodecVersion,
		"cases":        cases,
	}
	encoded, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		t.Fatalf("序列化 fixture 失败: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(fixturePath), 0o755); err != nil {
		t.Fatalf("创建 fixture 目录失败: %v", err)
	}
	if err := os.WriteFile(fixturePath, append(encoded, '\n'), 0o644); err != nil {
		t.Fatalf("写入 fixture 失败: %v", err)
	}
	t.Logf("已写入 %d 个 fixture 到 %s", len(cases), fixturePath)
}

func itoa(v uint16) string {
	if v == 0 {
		return "0"
	}
	var buf [8]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[i:])
}

var _ = time.Now
