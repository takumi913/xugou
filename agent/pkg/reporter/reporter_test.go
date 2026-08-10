package reporter

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/xugou/agent/pkg/config"
	"github.com/xugou/agent/pkg/model"
)

func TestReporterSendsGzipV4BatchWithBearerCredential(t *testing.T) {
	originalServer, originalToken := config.ServerURL, config.Token
	originalCollect, originalReport := config.CollectInterval, config.ReportInterval
	defer func() {
		config.ServerURL, config.Token = originalServer, originalToken
		config.CollectInterval, config.ReportInterval = originalCollect, originalReport
	}()

	registerCalls := 0
	reportCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v2/agents/register":
			registerCalls++
			if r.Header.Get("Authorization") != "Bearer xga_test" {
				t.Errorf("注册 Authorization=%q", r.Header.Get("Authorization"))
			}
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Errorf("解码注册请求: %v", err)
			}
			if _, exists := payload["token"]; exists {
				t.Error("注册 JSON 不应包含凭据")
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":{"agent_id":1,"created":true}}`))
		case "/api/v2/agents/reports":
			reportCalls++
			if r.Header.Get("Authorization") != "Bearer xga_test" {
				t.Errorf("Authorization=%q", r.Header.Get("Authorization"))
			}
			if r.Header.Get("Content-Encoding") != "gzip" {
				t.Errorf("Content-Encoding=%q", r.Header.Get("Content-Encoding"))
			}
			reader, err := gzip.NewReader(r.Body)
			if err != nil {
				t.Errorf("创建 gzip reader: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			defer reader.Close()
			var report model.AgentReport
			if err := json.NewDecoder(reader).Decode(&report); err != nil {
				t.Errorf("解码 v4 report: %v", err)
			}
			if report.ReportID != "8bc16ef7-7035-48d0-854f-79471227439a" || len(report.Samples) != 1 {
				t.Errorf("v4 report 异常: %+v", report)
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"report_id":"8bc16ef7-7035-48d0-854f-79471227439a","accepted":true,"duplicate":false,"config":{"collect_interval_seconds":30,"report_interval_seconds":120,"update":false}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	config.ServerURL = server.URL
	config.Token = "xga_test"
	config.CollectInterval = 60
	config.ReportInterval = 300
	reporter := NewReporter()
	report := &model.AgentReport{
		ProtocolVersion:       4,
		AgentVersion:          "v0.2.0",
		ReportID:              "8bc16ef7-7035-48d0-854f-79471227439a",
		Hostname:              "node-a",
		OS:                    "linux",
		ReportIntervalSeconds: 300,
		Samples: []*model.AgentReportSample{{
			CollectedAt: time.Now().UTC().Format(time.RFC3339Nano),
			DynamicMetrics: model.DynamicMetrics{
				CPU:    model.CPUInfo{Usage: 10},
				Memory: model.MemoryInfo{Total: 100, Used: 10, Free: 90, UsageRate: 10},
				Load:   model.LoadInfo{},
			},
		}},
	}
	remote, err := reporter.Report(context.Background(), report)
	if err != nil {
		t.Fatal(err)
	}
	if remote == nil || remote.CollectInterval != 30 || remote.ReportInterval != 120 || remote.Update {
		t.Fatalf("配置响应异常: %+v", remote)
	}
	if registerCalls != 1 || reportCalls != 1 {
		t.Fatalf("请求次数异常: register=%d report=%d", registerCalls, reportCalls)
	}
}

func TestReporterRejectsOversizedRegistrationResponse(t *testing.T) {
	originalServer, originalToken := config.ServerURL, config.Token
	defer func() {
		config.ServerURL, config.Token = originalServer, originalToken
	}()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v2/agents/register" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(make([]byte, 64*1024+1))
	}))
	defer server.Close()

	config.ServerURL = server.URL
	config.Token = "xga_test"
	reporter := NewReporter()
	_, err := reporter.Report(context.Background(), &model.AgentReport{
		ProtocolVersion: 4,
		AgentVersion:    "v0.2.0",
		ReportID:        "8bc16ef7-7035-48d0-854f-79471227439a",
		Hostname:        "node-a",
		Samples: []*model.AgentReportSample{{
			CollectedAt: time.Now().UTC().Format(time.RFC3339Nano),
		}},
	})
	if err == nil {
		t.Fatal("expected oversized registration response to fail")
	}
}
