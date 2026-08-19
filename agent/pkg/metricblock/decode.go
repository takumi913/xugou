package metricblock

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"fmt"
	"io"
)

// DecodedBlock 是解码结果。Series 按 [series_id][agg][slot] 索引，
// nil 表示该槽缺值。
type DecodedBlock struct {
	Interval    int
	BucketStart int64
	SlotCount   int
	AggCount    int
	Dims        Dims
	MemoryTotal uint64
	SwapTotal   uint64
	Series      map[uint16][][]*float64
}

// Decode 解析块字节流。任何不满足规格的输入都返回 error，不 panic。
//
// 本实现只用于跨语言往返测试与本地校验；生产解码在服务端 TypeScript 侧。
func Decode(raw []byte) (*DecodedBlock, error) {
	if len(raw) < HeaderSize {
		return nil, fmt.Errorf("metricblock: 长度 %d 不足以容纳块头", len(raw))
	}
	if raw[0] != Magic {
		return nil, fmt.Errorf("metricblock: magic 错误 0x%02X", raw[0])
	}
	if raw[1] != CodecVersion {
		return nil, fmt.Errorf("metricblock: 不支持的 codec 版本 %d", raw[1])
	}
	interval := int(raw[2])
	if interval != 1 && interval != 60 {
		return nil, fmt.Errorf("metricblock: 非法 interval %d", interval)
	}
	flags := raw[3]
	aggCount := int(raw[4])
	if aggCount != 1 && aggCount != 3 {
		return nil, fmt.Errorf("metricblock: 非法 aggregate_count %d", aggCount)
	}
	seriesCount := int(binary.LittleEndian.Uint16(raw[6:]))
	if seriesCount > MaxSeriesCount {
		return nil, fmt.Errorf("metricblock: 序列数 %d 超上限", seriesCount)
	}
	slotCount := int(binary.LittleEndian.Uint16(raw[8:]))
	if slotCount == 0 || slotCount > MaxPointCount {
		return nil, fmt.Errorf("metricblock: 非法 slot_count %d", slotCount)
	}
	out := &DecodedBlock{
		Interval:    interval,
		BucketStart: int64(binary.LittleEndian.Uint32(raw[12:])),
		SlotCount:   slotCount,
		AggCount:    aggCount,
		MemoryTotal: binary.LittleEndian.Uint64(raw[16:]),
		SwapTotal:   binary.LittleEndian.Uint64(raw[24:]),
		Series:      make(map[uint16][][]*float64, seriesCount),
	}

	off := HeaderSize
	dims, off, err := decodeDimHeader(raw, off)
	if err != nil {
		return nil, err
	}
	out.Dims = dims

	if off+seriesCount*4 > len(raw) {
		return nil, fmt.Errorf("metricblock: 描述符区被截断")
	}
	type descriptor struct {
		id   uint16
		spec SeriesSpec
	}
	descs := make([]descriptor, seriesCount)
	var prevID uint16
	for i := 0; i < seriesCount; i++ {
		id := binary.LittleEndian.Uint16(raw[off:])
		enc := raw[off+2]
		scale := raw[off+3]
		off += 4
		if _, ok := SpecFor(id); !ok {
			return nil, fmt.Errorf("metricblock: 非法 series_id %d", id)
		}
		if i > 0 && id <= prevID {
			return nil, fmt.Errorf("metricblock: 描述符未按 series_id 升序排列")
		}
		if enc > EncodingRaw {
			return nil, fmt.Errorf("metricblock: 非法 encoding %d", enc)
		}
		prevID = id
		descs[i] = descriptor{id: id, spec: SeriesSpec{Encoding: enc, Scale: scale}}
	}

	payload := raw[off:]
	if flags&FlagGzip != 0 {
		payload, err = gunzipLimited(payload, MaxDecompressedBytes)
		if err != nil {
			return nil, err
		}
	}

	hasPresence := flags&FlagPresence != 0
	pos := 0
	for _, d := range descs {
		aggs := make([][]*float64, aggCount)
		for agg := 0; agg < aggCount; agg++ {
			present := make([]bool, slotCount)
			if hasPresence {
				n := bitmapLen(slotCount)
				if pos+n > len(payload) {
					return nil, fmt.Errorf("metricblock: presence bitmap 被截断")
				}
				bitmap := payload[pos : pos+n]
				pos += n
				for i := 0; i < slotCount; i++ {
					present[i] = getBit(bitmap, i)
				}
			} else {
				for i := range present {
					present[i] = true
				}
			}
			values := make([]*float64, slotCount)
			var prev, prevDelta int64
			count := 0
			for slot := 0; slot < slotCount; slot++ {
				if !present[slot] {
					continue
				}
				var raw64 int64
				raw64, pos, err = readZigzag(payload, pos)
				if err != nil {
					return nil, err
				}
				var cur int64
				switch d.spec.Encoding {
				case EncodingRaw:
					cur = raw64
				case EncodingDeltaOfDelta:
					switch count {
					case 0:
						cur = raw64
					case 1:
						cur = prev + raw64
						prevDelta = raw64
					default:
						delta := prevDelta + raw64
						cur = prev + delta
						prevDelta = delta
					}
				default:
					if count == 0 {
						cur = raw64
					} else {
						cur = prev + raw64
					}
				}
				v := dequantize(cur, d.spec.Scale)
				values[slot] = &v
				prev = cur
				count++
			}
			aggs[agg] = values
		}
		out.Series[d.id] = aggs
	}
	if pos != len(payload) {
		return nil, fmt.Errorf("metricblock: Payload 有 %d 字节残留，与描述符不符", len(payload)-pos)
	}
	return out, nil
}

func decodeDimHeader(raw []byte, off int) (Dims, int, error) {
	var dims Dims
	readName := func() (string, error) {
		if off >= len(raw) {
			return "", fmt.Errorf("metricblock: 维度头被截断")
		}
		n := int(raw[off])
		off++
		if off+n > len(raw) {
			return "", fmt.Errorf("metricblock: 维度名被截断")
		}
		s := string(raw[off : off+n])
		off += n
		return s, nil
	}

	if off >= len(raw) {
		return dims, off, fmt.Errorf("metricblock: 维度头缺失")
	}
	diskCount := int(raw[off])
	off++
	if diskCount > MaxDimEntries {
		return dims, off, fmt.Errorf("metricblock: 磁盘数 %d 超上限", diskCount)
	}
	for i := 0; i < diskCount; i++ {
		name, err := readName()
		if err != nil {
			return dims, off, err
		}
		if off+8 > len(raw) {
			return dims, off, fmt.Errorf("metricblock: 磁盘 total 被截断")
		}
		total := binary.LittleEndian.Uint64(raw[off:])
		off += 8
		dims.Disks = append(dims.Disks, DiskDim{Name: name, Total: total})
	}

	if off >= len(raw) {
		return dims, off, fmt.Errorf("metricblock: 网卡计数缺失")
	}
	netCount := int(raw[off])
	off++
	if netCount > MaxDimEntries {
		return dims, off, fmt.Errorf("metricblock: 网卡数 %d 超上限", netCount)
	}
	for i := 0; i < netCount; i++ {
		name, err := readName()
		if err != nil {
			return dims, off, err
		}
		dims.Nets = append(dims.Nets, name)
	}

	if off >= len(raw) {
		return dims, off, fmt.Errorf("metricblock: ping 计数缺失")
	}
	pingCount := int(raw[off])
	off++
	if pingCount > MaxDimEntries {
		return dims, off, fmt.Errorf("metricblock: ping 数 %d 超上限", pingCount)
	}
	for i := 0; i < pingCount; i++ {
		name, err := readName()
		if err != nil {
			return dims, off, err
		}
		dims.Pings = append(dims.Pings, name)
	}
	return dims, off, nil
}

// gunzipLimited 解压并强制上限，防止 zip bomb 打爆内存。
func gunzipLimited(src []byte, limit int) ([]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(src))
	if err != nil {
		return nil, fmt.Errorf("metricblock: gzip 头无效: %w", err)
	}
	defer zr.Close()
	// 多读一字节用于判断是否超限
	out, err := io.ReadAll(io.LimitReader(zr, int64(limit)+1))
	if err != nil {
		return nil, fmt.Errorf("metricblock: gzip 解压失败: %w", err)
	}
	if len(out) > limit {
		return nil, fmt.Errorf("metricblock: 解压后超过 %d 字节上限", limit)
	}
	return out, nil
}
