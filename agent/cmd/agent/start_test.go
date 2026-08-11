package agent

import (
	"context"
	"testing"
	"time"

	"github.com/xugou/agent/pkg/config"
	"github.com/xugou/agent/pkg/model"
	"github.com/xugou/agent/pkg/spool"
)

type countingReporter struct {
	calls        int
	sampleCounts []int
}

func (r *countingReporter) Report(
	_ context.Context,
	report *model.AgentReport,
) (*config.RemoteConfig, error) {
	r.calls++
	r.sampleCounts = append(r.sampleCounts, len(report.Samples))
	return nil, nil
}

func TestReportSamplesSendsOnlyOneBatchPerCycle(t *testing.T) {
	store, err := spool.Open(spool.Options{
		Dir:        t.TempDir(),
		MaxEntries: spool.DefaultMaxSamples + 10,
	})
	if err != nil {
		t.Fatal(err)
	}

	base := time.Now().Add(-time.Minute)
	for i := 0; i < spool.DefaultMaxSamples+1; i++ {
		_, err := store.Add(&model.SystemInfo{
			AgentVersion: "test",
			Timestamp:    base.Add(time.Duration(i) * time.Second),
			Hostname:     "fixture",
			OS:           "linux",
		})
		if err != nil {
			t.Fatal(err)
		}
	}

	reporter := &countingReporter{}
	if remote := reportSamples(context.Background(), reporter, store); remote != nil {
		t.Fatalf("remote config = %#v, want nil", remote)
	}
	if reporter.calls != 1 {
		t.Fatalf("HTTP calls = %d, want 1", reporter.calls)
	}
	if len(reporter.sampleCounts) != 1 || reporter.sampleCounts[0] != spool.DefaultMaxSamples {
		t.Fatalf("sample counts = %v, want [%d]", reporter.sampleCounts, spool.DefaultMaxSamples)
	}
	stats, err := store.Stats()
	if err != nil {
		t.Fatal(err)
	}
	if stats.Samples != 1 {
		t.Fatalf("remaining samples = %d, want 1", stats.Samples)
	}
}
