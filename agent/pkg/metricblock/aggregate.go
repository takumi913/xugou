package metricblock

import (
	"time"

	"github.com/xugou/agent/pkg/model"
)

// 聚合槽位下标。EncodeRollup 按此顺序写入三个聚合值。
const (
	AggAvg = 0
	AggMin = 1
	AggMax = 2
)

// MinutePoint 是一分钟内所有序列的聚合结果。
type MinutePoint struct {
	MinuteStart int64
	Dims        Dims
	MemoryTotal uint64
	SwapTotal   uint64
	// Values 只包含该分钟内出现过的序列；缺席的序列不会出现在 map 里，
	// 编码时对应槽位的 presence 位为 0。
	Values map[uint16][3]float64
}

// Aggregate 从一分钟的原始样本算出 MinutePoint。
//
// 单调递增的网络计数器（EncodingDeltaOfDelta）取【最后一个值】而非平均值：
// 速率图靠相邻分钟的计数器差分还原，取平均会让差分结果系统性偏小。
// 这类序列的 avg/min/max 三元组统一写成 {last, last, last}。
func Aggregate(minuteStart int64, samples []*model.AgentReportSample) *MinutePoint {
	if len(samples) == 0 {
		return nil
	}
	last := samples[len(samples)-1]
	dims := dimsFromSample(last)

	// 复用编码器的字段展开逻辑：先把每个样本铺进一个 1 槽的 builder，
	// 再把各槽的值收集起来聚合，避免字段映射写两遍导致两处漂移。
	type acc struct {
		sum, min, max, last float64
		count               int
	}
	accs := make(map[uint16]*acc)

	scratch := newBuilder(minuteStart, 1, 1, dims)
	for _, s := range samples {
		ts, err := time.Parse(time.RFC3339Nano, s.CollectedAt)
		if err != nil {
			continue
		}
		if ts.Unix() < minuteStart || ts.Unix() >= minuteStart+60 {
			continue
		}
		// 每个样本都写到槽 0，取完即清，等价于一次字段展开
		for _, col := range scratch.cols {
			col.present[0][0] = false
		}
		scratch.fillSample(0, s)
		for id, col := range scratch.cols {
			if !col.present[0][0] {
				continue
			}
			v := col.values[0][0]
			a, ok := accs[id]
			if !ok {
				accs[id] = &acc{sum: v, min: v, max: v, last: v, count: 1}
				continue
			}
			a.sum += v
			a.last = v
			a.count++
			if v < a.min {
				a.min = v
			}
			if v > a.max {
				a.max = v
			}
		}
	}
	if len(accs) == 0 {
		return nil
	}

	values := make(map[uint16][3]float64, len(accs))
	for id, a := range accs {
		spec, ok := SpecFor(id)
		if !ok {
			continue
		}
		if spec.Encoding == EncodingDeltaOfDelta {
			// 单调计数器：三个聚合位都写最后值，保证相邻分钟可差分
			values[id] = [3]float64{a.last, a.last, a.last}
			continue
		}
		if spec.Encoding == EncodingRaw {
			// 布尔量：avg 无意义，取最后值；min/max 仍反映该分钟内的翻转
			values[id] = [3]float64{a.last, a.min, a.max}
			continue
		}
		values[id] = [3]float64{a.sum / float64(a.count), a.min, a.max}
	}

	var swapTotal uint64
	if last.Swap != nil {
		swapTotal = last.Swap.Total
	}
	return &MinutePoint{
		MinuteStart: minuteStart,
		Dims:        dims,
		MemoryTotal: last.Memory.Total,
		SwapTotal:   swapTotal,
		Values:      values,
	}
}
