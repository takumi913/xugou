package metricblock

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/xugou/agent/pkg/model"
)

// SlotsPerBlock 是每个块的时间槽数。两种分辨率都是 60：
//   - resolution=1  ：桶为 1 分钟，60 个 1 秒槽
//   - resolution=60 ：桶为 1 小时，60 个 1 分钟槽
const SlotsPerBlock = 60

// BucketSpanSeconds 返回给定分辨率下一个桶覆盖的秒数。
func BucketSpanSeconds(interval int) int64 { return int64(interval) * SlotsPerBlock }

// BucketStartFor 把时间戳对齐到所属桶的起点。
func BucketStartFor(unixSeconds int64, interval int) int64 {
	span := BucketSpanSeconds(interval)
	return unixSeconds - ((unixSeconds%span)+span)%span
}

// DiskDim 是一块磁盘的静态维度。Name 用挂载点（比设备名稳定）。
type DiskDim struct {
	Name  string
	Total uint64
}

// Dims 是块的自描述维度头：磁盘、网卡、ping 线路的拓扑。
// slot 序号即各切片中的下标。
type Dims struct {
	Disks []DiskDim
	Nets  []string
	Pings []string
}

// Block 是一个编码完成的指标块。
//
// PointCount 是【实际存在】的槽数，用于服务端 upsert 的单调守卫
// （重启后重传的短块不得覆盖更完整的既有块）；块头里的 slot_count 恒为
// SlotsPerBlock，用于确定 presence bitmap 的宽度。两者含义不同，勿混用。
type Block struct {
	Resolution  int
	BucketStart int64
	PointCount  int
	Data        []byte
}

type column struct {
	spec    SeriesSpec
	values  [][]float64 // [agg][slot]
	present [][]bool    // [agg][slot]
}

type builder struct {
	interval    int
	bucketStart int64
	aggCount    int
	dims        Dims
	cols        map[uint16]*column
	slotUsed    []bool
	totals      [2]uint64 // memory_total, swap_total
	totalsSet   bool
}

// setTotals 记录随块携带的静态总量。usage_rate / free 由解码端用它们推导，
// 因此不进入每秒序列。
func (b *builder) setTotals(memoryTotal, swapTotal uint64) {
	b.totals = [2]uint64{memoryTotal, swapTotal}
	b.totalsSet = true
}

func newBuilder(bucketStart int64, interval, aggCount int, dims Dims) *builder {
	return &builder{
		interval:    interval,
		bucketStart: bucketStart,
		aggCount:    aggCount,
		dims:        dims,
		cols:        make(map[uint16]*column),
		slotUsed:    make([]bool, SlotsPerBlock),
	}
}

func (b *builder) column(id uint16) (*column, bool) {
	if col, ok := b.cols[id]; ok {
		return col, true
	}
	spec, ok := SpecFor(id)
	if !ok {
		return nil, false
	}
	col := &column{
		spec:    spec,
		values:  make([][]float64, b.aggCount),
		present: make([][]bool, b.aggCount),
	}
	for agg := 0; agg < b.aggCount; agg++ {
		col.values[agg] = make([]float64, SlotsPerBlock)
		col.present[agg] = make([]bool, SlotsPerBlock)
	}
	b.cols[id] = col
	return col, true
}

// set 写入一个值。slot 越界或 series_id 非法时静默忽略——编码器不应
// 因为采集侧的异常数据而整块失败。
func (b *builder) set(id uint16, agg, slot int, value float64) {
	if slot < 0 || slot >= SlotsPerBlock || agg < 0 || agg >= b.aggCount {
		return
	}
	col, ok := b.column(id)
	if !ok {
		return
	}
	col.values[agg][slot] = value
	col.present[agg][slot] = true
	b.slotUsed[slot] = true
}

func (b *builder) presentSlots() int {
	n := 0
	for _, used := range b.slotUsed {
		if used {
			n++
		}
	}
	return n
}

// dimsFromSample 以给定样本的拓扑作为整块的维度头。
// 调用方传入最后一个样本 —— 它反映当前最新的磁盘/网卡状态。
func dimsFromSample(s *model.AgentReportSample) Dims {
	var dims Dims
	for _, d := range s.Disks {
		if len(dims.Disks) >= MaxDimEntries {
			break
		}
		dims.Disks = append(dims.Disks, DiskDim{Name: truncateName(d.MountPoint), Total: d.Total})
	}
	for _, n := range s.Network {
		if len(dims.Nets) >= MaxDimEntries {
			break
		}
		dims.Nets = append(dims.Nets, truncateName(n.Interface))
	}
	keys := make([]string, 0, len(s.Ping))
	for k := range s.Ping {
		keys = append(keys, k)
	}
	// map 迭代顺序随机，必须排序才能保证同一拓扑编码出稳定的 slot 序号
	sort.Strings(keys)
	for _, k := range keys {
		if len(dims.Pings) >= MaxDimEntries {
			break
		}
		dims.Pings = append(dims.Pings, truncateName(k))
	}
	return dims
}

// truncateName 把名称截断到 255 字节且不切断 UTF-8 字符。
func truncateName(s string) string {
	if len(s) <= 255 {
		return s
	}
	cut := 255
	for cut > 0 && s[cut]&0xC0 == 0x80 {
		cut--
	}
	return s[:cut]
}

// fillSample 把一个原始样本写入指定槽位。
func (b *builder) fillSample(slot int, s *model.AgentReportSample) {
	b.set(SeriesCPUUsage, 0, slot, s.CPU.Usage)
	b.set(SeriesMemoryUsed, 0, slot, float64(s.Memory.Used))
	b.set(SeriesMemoryFree, 0, slot, float64(s.Memory.Free))
	b.set(SeriesLoad1, 0, slot, s.Load.Load1)
	b.set(SeriesLoad5, 0, slot, s.Load.Load5)
	b.set(SeriesLoad15, 0, slot, s.Load.Load15)
	if s.Swap != nil {
		b.set(SeriesSwapUsed, 0, slot, float64(s.Swap.Used))
	}
	b.set(SeriesProcessCount, 0, slot, float64(s.ProcessCount))
	b.set(SeriesTCPConnections, 0, slot, float64(s.TCPConnections))
	b.set(SeriesUDPConnections, 0, slot, float64(s.UDPConnections))
	if s.IPv4Reachable != nil {
		b.set(SeriesIPv4Reachable, 0, slot, boolToFloat(*s.IPv4Reachable))
	}
	if s.IPv6Reachable != nil {
		b.set(SeriesIPv6Reachable, 0, slot, boolToFloat(*s.IPv6Reachable))
	}

	// 按名称匹配到维度头里的 slot，拓扑变化时自动落到正确的列
	for _, d := range s.Disks {
		if idx := indexOfDisk(b.dims.Disks, truncateName(d.MountPoint)); idx >= 0 {
			b.set(DiskSeriesID(idx), 0, slot, float64(d.Used))
		}
	}
	for _, n := range s.Network {
		idx := indexOf(b.dims.Nets, truncateName(n.Interface))
		if idx < 0 {
			continue
		}
		b.set(NetSeriesID(idx, NetFieldBytesSent), 0, slot, float64(n.BytesSent))
		b.set(NetSeriesID(idx, NetFieldBytesRecv), 0, slot, float64(n.BytesRecv))
		b.set(NetSeriesID(idx, NetFieldPacketsSent), 0, slot, float64(n.PacketsSent))
		b.set(NetSeriesID(idx, NetFieldPacketsRecv), 0, slot, float64(n.PacketsRecv))
	}
	for key, p := range s.Ping {
		idx := indexOf(b.dims.Pings, truncateName(key))
		if idx < 0 {
			continue
		}
		b.set(PingSeriesID(idx, PingFieldLatencyMs), 0, slot, p.LatencyMs)
		b.set(PingSeriesID(idx, PingFieldLoss), 0, slot, boolToFloat(p.Loss))
	}
}

func boolToFloat(v bool) float64 {
	if v {
		return 1
	}
	return 0
}

func indexOf(list []string, want string) int {
	for i, v := range list {
		if v == want {
			return i
		}
	}
	return -1
}

func indexOfDisk(list []DiskDim, want string) int {
	for i, v := range list {
		if v.Name == want {
			return i
		}
	}
	return -1
}

var errNoSamples = errors.New("metricblock: 样本为空")

// Encode 把同一分钟桶内的原始样本编码为 resolution=1 的块。
// samples 需属于同一个桶；不属于该桶的样本会被丢弃。
func Encode(bucketStart int64, samples []*model.AgentReportSample) (*Block, error) {
	if len(samples) == 0 {
		return nil, errNoSamples
	}
	last := samples[len(samples)-1]
	dims := dimsFromSample(last)
	b := newBuilder(bucketStart, 1, 1, dims)
	var swapTotal uint64
	if last.Swap != nil {
		swapTotal = last.Swap.Total
	}
	b.setTotals(last.Memory.Total, swapTotal)
	for _, s := range samples {
		ts, err := time.Parse(time.RFC3339Nano, s.CollectedAt)
		if err != nil {
			continue
		}
		slot := int(ts.Unix() - bucketStart)
		if slot < 0 || slot >= SlotsPerBlock {
			continue
		}
		b.fillSample(slot, s)
	}
	if b.presentSlots() == 0 {
		return nil, errNoSamples
	}
	data, err := b.encode()
	if err != nil {
		return nil, err
	}
	return &Block{Resolution: 1, BucketStart: bucketStart, PointCount: b.presentSlots(), Data: data}, nil
}

// EncodeRollup 把一小时内累积的分钟聚合点编码为 resolution=60 的块。
func EncodeRollup(hourStart int64, points []*MinutePoint) (*Block, error) {
	if len(points) == 0 {
		return nil, errNoSamples
	}
	last := points[len(points)-1]
	b := newBuilder(hourStart, 60, 3, last.Dims)
	b.setTotals(last.MemoryTotal, last.SwapTotal)
	for _, p := range points {
		slot := int((p.MinuteStart - hourStart) / 60)
		if slot < 0 || slot >= SlotsPerBlock {
			continue
		}
		for id, aggs := range p.Values {
			for agg := 0; agg < 3; agg++ {
				b.set(id, agg, slot, aggs[agg])
			}
		}
	}
	if b.presentSlots() == 0 {
		return nil, errNoSamples
	}
	data, err := b.encode()
	if err != nil {
		return nil, err
	}
	return &Block{Resolution: 60, BucketStart: hourStart, PointCount: b.presentSlots(), Data: data}, nil
}

// encode 生成完整块字节流：Header || DimHeader || SeriesDescriptors || Payload。
func (b *builder) encode() ([]byte, error) {
	ids := make([]uint16, 0, len(b.cols))
	for id := range b.cols {
		ids = append(ids, id)
	}
	// 描述符与 Payload 段顺序都依赖此排序
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	if len(ids) > MaxSeriesCount {
		return nil, fmt.Errorf("metricblock: 序列数 %d 超过上限 %d", len(ids), MaxSeriesCount)
	}

	// 是否需要 presence bitmap：只要有任一槽缺值就需要
	needPresence := false
	for _, id := range ids {
		col := b.cols[id]
		for agg := 0; agg < b.aggCount; agg++ {
			for slot := 0; slot < SlotsPerBlock; slot++ {
				if !col.present[agg][slot] {
					needPresence = true
					break
				}
			}
			if needPresence {
				break
			}
		}
		if needPresence {
			break
		}
	}

	payload := b.encodePayload(ids, needPresence)

	var compressed bytes.Buffer
	zw, err := gzip.NewWriterLevel(&compressed, gzip.BestCompression)
	if err != nil {
		return nil, err
	}
	if _, err := zw.Write(payload); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}

	flags := FlagGzip
	if needPresence {
		flags |= FlagPresence
	}

	var memTotal, swapTotal uint64
	if v, ok := b.staticTotals(); ok {
		memTotal, swapTotal = v[0], v[1]
	}

	out := make([]byte, HeaderSize)
	out[0] = Magic
	out[1] = CodecVersion
	out[2] = byte(b.interval)
	out[3] = flags
	out[4] = byte(b.aggCount)
	out[5] = 0
	binary.LittleEndian.PutUint16(out[6:], uint16(len(ids)))
	binary.LittleEndian.PutUint16(out[8:], uint16(SlotsPerBlock))
	binary.LittleEndian.PutUint16(out[10:], 0)
	binary.LittleEndian.PutUint32(out[12:], uint32(b.bucketStart))
	binary.LittleEndian.PutUint64(out[16:], memTotal)
	binary.LittleEndian.PutUint64(out[24:], swapTotal)

	out = b.appendDimHeader(out)
	for _, id := range ids {
		col := b.cols[id]
		var desc [4]byte
		binary.LittleEndian.PutUint16(desc[0:], id)
		desc[2] = col.spec.Encoding
		desc[3] = col.spec.Scale
		out = append(out, desc[:]...)
	}
	return append(out, compressed.Bytes()...), nil
}

// staticTotals 保存 memory_total / swap_total，由 SetTotals 注入。
func (b *builder) staticTotals() ([2]uint64, bool) { return b.totals, b.totalsSet }

func (b *builder) appendDimHeader(out []byte) []byte {
	out = append(out, byte(len(b.dims.Disks)))
	for _, d := range b.dims.Disks {
		out = append(out, byte(len(d.Name)))
		out = append(out, d.Name...)
		var buf [8]byte
		binary.LittleEndian.PutUint64(buf[:], d.Total)
		out = append(out, buf[:]...)
	}
	out = append(out, byte(len(b.dims.Nets)))
	for _, n := range b.dims.Nets {
		out = append(out, byte(len(n)))
		out = append(out, n...)
	}
	out = append(out, byte(len(b.dims.Pings)))
	for _, p := range b.dims.Pings {
		out = append(out, byte(len(p)))
		out = append(out, p...)
	}
	return out
}

// encodePayload 按描述符顺序逐序列拼接数据段。
func (b *builder) encodePayload(ids []uint16, needPresence bool) []byte {
	payload := make([]byte, 0, len(ids)*SlotsPerBlock*2)
	for _, id := range ids {
		col := b.cols[id]
		for agg := 0; agg < b.aggCount; agg++ {
			present := col.present[agg]
			if needPresence {
				bitmap := make([]byte, bitmapLen(SlotsPerBlock))
				for slot := 0; slot < SlotsPerBlock; slot++ {
					if present[slot] {
						setBit(bitmap, slot)
					}
				}
				payload = append(payload, bitmap...)
			}
			payload = b.encodeSeries(payload, col, agg)
		}
	}
	return payload
}

func (b *builder) encodeSeries(payload []byte, col *column, agg int) []byte {
	var prev, prevDelta int64
	count := 0
	for slot := 0; slot < SlotsPerBlock; slot++ {
		if !col.present[agg][slot] {
			continue
		}
		cur := quantize(col.values[agg][slot], col.spec.Scale)
		switch col.spec.Encoding {
		case EncodingRaw:
			payload = appendZigzag(payload, cur)
		case EncodingDeltaOfDelta:
			switch count {
			case 0:
				payload = appendZigzag(payload, cur)
			case 1:
				d := cur - prev
				payload = appendZigzag(payload, d)
				prevDelta = d
			default:
				d := cur - prev
				payload = appendZigzag(payload, d-prevDelta)
				prevDelta = d
			}
		default: // EncodingDelta
			if count == 0 {
				payload = appendZigzag(payload, cur)
			} else {
				payload = appendZigzag(payload, cur-prev)
			}
		}
		prev = cur
		count++
	}
	return payload
}
