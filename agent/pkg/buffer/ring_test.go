package buffer

import "testing"

func TestRingPushAndLen(t *testing.T) {
	r := NewRing[int](3)
	if r.Len() != 0 {
		t.Fatalf("新缓冲长度应为 0，实际 %d", r.Len())
	}

	r.Push(1)
	r.Push(2)
	if r.Len() != 2 {
		t.Fatalf("长度应为 2，实际 %d", r.Len())
	}
}

func TestRingOverflowDropsOldest(t *testing.T) {
	r := NewRing[int](3)
	for i := 1; i <= 5; i++ {
		r.Push(i)
	}

	if r.Len() != 3 {
		t.Fatalf("超容量后长度应为 3，实际 %d", r.Len())
	}

	got := r.Snapshot()
	want := []int{3, 4, 5}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("超容量后应保留最新元素 %v，实际 %v", want, got)
		}
	}
}

func TestRingSnapshotDoesNotClear(t *testing.T) {
	r := NewRing[string](10)
	r.Push("a")
	r.Push("b")

	snapshot := r.Snapshot()
	if len(snapshot) != 2 || snapshot[0] != "a" || snapshot[1] != "b" {
		t.Fatalf("Snapshot 应按写入顺序返回全部元素，实际 %v", snapshot)
	}
	if r.Len() != 2 {
		t.Fatalf("Snapshot 不应清空缓冲，实际长度 %d", r.Len())
	}

	// 修改快照不应影响内部状态
	snapshot[0] = "modified"
	if r.Snapshot()[0] != "a" {
		t.Fatal("修改快照不应影响缓冲内部数据")
	}
}

func TestRingClearEmptiesBuffer(t *testing.T) {
	r := NewRing[int](5)
	r.Push(1)
	r.Push(2)
	r.Push(3)

	r.Clear()
	if r.Len() != 0 {
		t.Fatalf("Clear 后缓冲应为空，实际长度 %d", r.Len())
	}

	// 清空后可继续写入
	r.Push(4)
	if got := r.Snapshot(); len(got) != 1 || got[0] != 4 {
		t.Fatalf("Clear 后写入应正常，实际 %v", got)
	}

	// 空缓冲 Clear 应无副作用
	r.Clear()
	r.Clear()
	if r.Len() != 0 {
		t.Fatalf("空缓冲 Clear 后长度应为 0，实际 %d", r.Len())
	}
}

func TestRingZeroCapacityFallsBackToDefault(t *testing.T) {
	r := NewRing[int](0)
	for i := range DefaultCapacity + 50 {
		r.Push(i)
	}
	if r.Len() != DefaultCapacity {
		t.Fatalf("容量应回退为默认值 %d，实际长度 %d", DefaultCapacity, r.Len())
	}
	if got := r.Snapshot()[0]; got != 50 {
		t.Fatalf("应丢弃最旧的 50 个元素，队首应为 50，实际 %d", got)
	}
}
