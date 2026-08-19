package metricblock

import (
	"errors"
	"math"
)

// zigzag 把有符号整数映射到无符号，使小绝对值（无论正负）都得到短 varint。
func zigzag(v int64) uint64 {
	return uint64((v << 1) ^ (v >> 63))
}

// unzigzag 是 zigzag 的逆映射。
func unzigzag(v uint64) int64 {
	return int64(v>>1) ^ -int64(v&1)
}

// appendVarint 以 7 位一组 LSB-first 追加无符号整数，高位为续位标志。
func appendVarint(dst []byte, v uint64) []byte {
	for v >= 0x80 {
		dst = append(dst, byte(v)|0x80)
		v >>= 7
	}
	return append(dst, byte(v))
}

// appendZigzag 追加一个有符号整数。
func appendZigzag(dst []byte, v int64) []byte {
	return appendVarint(dst, zigzag(v))
}

var (
	errVarintTruncated = errors.New("metricblock: varint 被截断")
	errVarintOverflow  = errors.New("metricblock: varint 超出 64 位")
)

// readVarint 从 buf[offset:] 读一个 varint，返回值与新的偏移。
func readVarint(buf []byte, offset int) (uint64, int, error) {
	var result uint64
	var shift uint
	for {
		if offset >= len(buf) {
			return 0, offset, errVarintTruncated
		}
		b := buf[offset]
		offset++
		if shift >= 64 {
			return 0, offset, errVarintOverflow
		}
		if shift == 63 && b > 1 {
			return 0, offset, errVarintOverflow
		}
		result |= uint64(b&0x7f) << shift
		if b < 0x80 {
			return result, offset, nil
		}
		shift += 7
	}
}

// readZigzag 从 buf[offset:] 读一个有符号整数。
func readZigzag(buf []byte, offset int) (int64, int, error) {
	raw, next, err := readVarint(buf, offset)
	if err != nil {
		return 0, next, err
	}
	return unzigzag(raw), next, nil
}

// scaleFactors 缓存 10^n，避免热路径反复调用 math.Pow。
var scaleFactors = [...]float64{1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8}

// scaleFactor 返回 10^scale。scale 超出表范围时回退到 math.Pow。
func scaleFactor(scale uint8) float64 {
	if int(scale) < len(scaleFactors) {
		return scaleFactors[scale]
	}
	return math.Pow(10, float64(scale))
}

// quantize 把浮点值按 scale 定点化。NaN/Inf 归零——它们不应进入编码路径，
// 调用方需先用 present 标记过滤掉。
func quantize(value float64, scale uint8) int64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	scaled := value * scaleFactor(scale)
	// 钳到 int64 可表示范围，避免溢出后符号翻转产生乱码块
	if scaled >= math.MaxInt64 {
		return math.MaxInt64
	}
	if scaled <= math.MinInt64 {
		return math.MinInt64
	}
	return int64(math.Round(scaled))
}

// dequantize 是 quantize 的逆运算。
func dequantize(stored int64, scale uint8) float64 {
	return float64(stored) / scaleFactor(scale)
}

// bitmapLen 返回容纳 n 个 bit 所需的字节数。
func bitmapLen(n int) int { return (n + 7) / 8 }

// setBit 在 LSB-first 位图中置位。
func setBit(bitmap []byte, i int) { bitmap[i/8] |= 1 << (i % 8) }

// getBit 读取 LSB-first 位图。
func getBit(bitmap []byte, i int) bool { return bitmap[i/8]&(1<<(i%8)) != 0 }
