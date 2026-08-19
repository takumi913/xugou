// Package metricblock 实现指标块的列式压缩编码（codec v1）。
//
// 设计文档：docs/指标存储重构设计.md
//
// 生产链路上本包只做编码，解码在服务端 TypeScript 侧实现；
// 本包内的解码器仅供跨语言往返测试与本地校验使用。
package metricblock

// 块格式常量。两端必须逐字节一致，修改前先看设计文档 §3。
const (
	Magic        byte = 0xB1
	CodecVersion byte = 1

	// HeaderSize 固定 32 字节：前 16 字节为标量字段，
	// 其后 memory_total (16..23) 与 swap_total (24..31) 各占 8 字节。
	HeaderSize = 32

	// FlagGzip 表示 Payload 经 gzip 压缩。
	FlagGzip byte = 0x01
	// FlagPresence 表示 Payload 含 presence bitmap。
	FlagPresence byte = 0x02

	MaxSeriesCount = 512
	MaxPointCount  = 3600
	// MaxDimEntries 限制单块内磁盘/网卡/ping 的实例数，超出部分丢弃。
	MaxDimEntries = 64
	// MaxDecompressedBytes 解压上限，防 zip bomb。
	MaxDecompressedBytes = 1 << 20
)

// 编码方式。
const (
	// EncodingDelta 首值绝对，其后为与前一个 present 值的差。
	EncodingDelta byte = 0
	// EncodingDeltaOfDelta 首值绝对，次值一阶差，其后二阶差。用于单调计数器。
	EncodingDeltaOfDelta byte = 1
	// EncodingRaw 每点独立绝对值。用于布尔量。
	EncodingRaw byte = 2
)

// 标量序列 ID（1–99）。
const (
	SeriesCPUUsage       uint16 = 1
	SeriesMemoryUsed     uint16 = 2
	SeriesMemoryFree     uint16 = 3
	SeriesLoad1          uint16 = 4
	SeriesLoad5          uint16 = 5
	SeriesLoad15         uint16 = 6
	SeriesSwapUsed       uint16 = 7
	SeriesProcessCount   uint16 = 8
	SeriesTCPConnections uint16 = 9
	SeriesUDPConnections uint16 = 10
	SeriesIPv4Reachable  uint16 = 11
	SeriesIPv6Reachable  uint16 = 12
)

// 按实例的序列 ID 基址。slot 序号由 DimHeader 中的出现顺序决定（0-based）。
const (
	SeriesDiskBase uint16 = 100 // 100 + slot            -> disks[slot].used
	SeriesNetBase  uint16 = 200 // 200 + slot*4 + field
	SeriesPingBase uint16 = 500 // 500 + slot*2 + field
)

// 网卡字段偏移。
const (
	NetFieldBytesSent   = 0
	NetFieldBytesRecv   = 1
	NetFieldPacketsSent = 2
	NetFieldPacketsRecv = 3
)

// ping 字段偏移。
const (
	PingFieldLatencyMs = 0
	PingFieldLoss      = 1
)

// 各区间的上界（含），用于解码校验。
const (
	seriesScalarMax uint16 = 99
	seriesDiskMax   uint16 = SeriesDiskBase + MaxDimEntries - 1   // 163
	seriesNetMax    uint16 = SeriesNetBase + MaxDimEntries*4 - 1  // 455
	seriesPingMax   uint16 = SeriesPingBase + MaxDimEntries*2 - 1 // 627
)

// SeriesSpec 描述一个序列的编码方式与定点缩放。
type SeriesSpec struct {
	Encoding byte
	Scale    uint8 // stored_int = round(value * 10^Scale)
}

// scalarSpecs 是标量序列的编码规格。
var scalarSpecs = map[uint16]SeriesSpec{
	SeriesCPUUsage:       {EncodingDelta, 2},
	SeriesMemoryUsed:     {EncodingDelta, 0},
	SeriesMemoryFree:     {EncodingDelta, 0},
	SeriesLoad1:          {EncodingDelta, 2},
	SeriesLoad5:          {EncodingDelta, 2},
	SeriesLoad15:         {EncodingDelta, 2},
	SeriesSwapUsed:       {EncodingDelta, 0},
	SeriesProcessCount:   {EncodingDelta, 0},
	SeriesTCPConnections: {EncodingDelta, 0},
	SeriesUDPConnections: {EncodingDelta, 0},
	SeriesIPv4Reachable:  {EncodingRaw, 0},
	SeriesIPv6Reachable:  {EncodingRaw, 0},
}

// SpecFor 返回序列 ID 对应的编码规格。第二个返回值为 false 表示 ID 非法。
//
// 注意：1 分钟聚合块里同一个 series_id 承载 avg/min/max 三个聚合值，
// 它们共用同一份 SeriesSpec —— 聚合不改变量纲，也不改变编码方式。
func SpecFor(id uint16) (SeriesSpec, bool) {
	if spec, ok := scalarSpecs[id]; ok {
		return spec, true
	}
	switch {
	case id >= SeriesDiskBase && id <= seriesDiskMax:
		// disks[slot].used：字节数，缓慢变化
		return SeriesSpec{EncodingDelta, 0}, true
	case id >= SeriesNetBase && id <= seriesNetMax:
		// 网络计数器单调递增，二阶差在速率平稳时接近 0
		return SeriesSpec{EncodingDeltaOfDelta, 0}, true
	case id >= SeriesPingBase && id <= seriesPingMax:
		if (id-SeriesPingBase)%2 == PingFieldLoss {
			return SeriesSpec{EncodingRaw, 0}, true
		}
		// latency_ms 保留三位小数（微秒级）
		return SeriesSpec{EncodingDelta, 3}, true
	}
	return SeriesSpec{}, false
}

// DiskSeriesID 返回第 slot 块磁盘的 used 序列 ID。
func DiskSeriesID(slot int) uint16 { return SeriesDiskBase + uint16(slot) }

// NetSeriesID 返回第 slot 个网卡指定字段的序列 ID。
func NetSeriesID(slot, field int) uint16 {
	return SeriesNetBase + uint16(slot*4+field)
}

// PingSeriesID 返回第 slot 条线路指定字段的序列 ID。
func PingSeriesID(slot, field int) uint16 {
	return SeriesPingBase + uint16(slot*2+field)
}
