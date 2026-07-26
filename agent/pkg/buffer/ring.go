// Package buffer 提供采集样本的内存环形缓冲：
// 超过容量时丢弃最旧样本，保证上报失败期间内存占用有上限。
package buffer

import "sync"

// DefaultCapacity 默认样本缓冲上限。
// 与服务端两处上限互为镜像，修改时必须三处同步：
//   - backend/src/api/schemas.ts 中 samples 的 z.array(...).max(300)
//   - backend/src/durable/MetricsBroadcaster.ts 的 MAX_SAMPLES_PER_AGENT = 300
const DefaultCapacity = 300

// Ring 是带上限的先进先出缓冲，写满后覆盖最旧元素。并发安全。
type Ring[T any] struct {
	mu       sync.Mutex
	items    []T
	capacity int
}

// NewRing 创建容量为 capacity 的环形缓冲；capacity <= 0 时使用 DefaultCapacity
func NewRing[T any](capacity int) *Ring[T] {
	if capacity <= 0 {
		capacity = DefaultCapacity
	}
	return &Ring[T]{
		items:    make([]T, 0, capacity),
		capacity: capacity,
	}
}

// Push 追加一个元素，超出容量时丢弃最旧的元素
func (r *Ring[T]) Push(item T) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.items = append(r.items, item)
	if len(r.items) > r.capacity {
		overflow := len(r.items) - r.capacity
		r.items = append(r.items[:0], r.items[overflow:]...)
	}
}

// Len 返回当前缓冲的元素个数
func (r *Ring[T]) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.items)
}

// Snapshot 返回当前全部元素的拷贝（按写入顺序），不清空缓冲
func (r *Ring[T]) Snapshot() []T {
	r.mu.Lock()
	defer r.mu.Unlock()

	out := make([]T, len(r.items))
	copy(out, r.items)
	return out
}

// Clear 清空缓冲。与 Snapshot 配合实现"先快照上报、成功后清空"，
// 避免 Snapshot+Drain 的双份拷贝。
func (r *Ring[T]) Clear() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.items = r.items[:0]
}
