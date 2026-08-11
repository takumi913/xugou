package realtime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/xugou/agent/pkg/model"
)

func TestBuildWebSocketURL(t *testing.T) {
	tests := map[string]string{
		"https://monitor.example.com":       "wss://monitor.example.com/api/v2/agents/live",
		"http://127.0.0.1:8787/":            "ws://127.0.0.1:8787/api/v2/agents/live",
		"https://example.com/base?old=true": "wss://example.com/base/api/v2/agents/live",
	}
	for input, want := range tests {
		got, err := buildWebSocketURL(input)
		if err != nil {
			t.Fatalf("buildWebSocketURL(%q): %v", input, err)
		}
		if got != want {
			t.Fatalf("buildWebSocketURL(%q)=%q, want %q", input, got, want)
		}
	}
}

func TestClientAuthenticatesAndPublishesUpstreamFrame(t *testing.T) {
	received := make(chan model.LiveMetricFrame, 1)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v2/agents/live" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer fixture-token" {
			http.Error(w, "bad authorization", http.StatusUnauthorized)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_, payload, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var frame model.LiveMetricFrame
		if json.Unmarshal(payload, &frame) == nil {
			received <- frame
		}
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "fixture-token", "1.2.6", "")
	if err != nil {
		t.Fatal(err)
	}
	info := &model.SystemInfo{Timestamp: time.Now()}
	info.CPU = model.CPUInfo{Usage: 21, Cores: 2, ModelName: "fixture"}
	info.Memory = model.MemoryInfo{Total: 100, Used: 40, Free: 60, UsageRate: 40}
	client.Publish(info)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go client.Run(ctx)

	select {
	case frame := <-received:
		if frame.Type != "metric" || frame.ProtocolVersion != 1 || frame.CPU.Usage != 21 {
			t.Fatalf("实时帧异常: %+v", frame)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("等待实时帧超时")
	}
}

func TestPublishKeepsLatestFrameAndComputesSpeed(t *testing.T) {
	client, err := NewClient("https://monitor.example.com", "token", "1.0.0", "")
	if err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 8, 11, 0, 0, 0, 0, time.UTC)
	first := &model.SystemInfo{Timestamp: start}
	first.Network = []model.NetworkInfo{
		{Interface: "lo", BytesRecv: 10_000, BytesSent: 20_000},
		{Interface: "eth0", BytesRecv: 1_000, BytesSent: 2_000},
	}
	client.Publish(first)
	second := &model.SystemInfo{Timestamp: start.Add(time.Second)}
	second.Network = []model.NetworkInfo{
		{Interface: "lo", BytesRecv: 30_000, BytesSent: 50_000},
		{Interface: "eth0", BytesRecv: 4_000, BytesSent: 7_000},
	}
	client.Publish(second)

	frame := <-client.latest
	if frame.Sequence != 2 {
		t.Fatalf("sequence=%d, want 2", frame.Sequence)
	}
	if frame.NetworkRxSpeed == nil || *frame.NetworkRxSpeed != 3_000 {
		t.Fatalf("rx speed=%v, want 3000", frame.NetworkRxSpeed)
	}
	if frame.NetworkTxSpeed == nil || *frame.NetworkTxSpeed != 5_000 {
		t.Fatalf("tx speed=%v, want 5000", frame.NetworkTxSpeed)
	}
}
