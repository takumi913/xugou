// Package spool 提供有上限的持久化 Agent 上报队列。
//
// 每次采集先以不含 Token 的独立文件落盘；组批时创建一个原子 inflight
// manifest，其中固化 report_id、Payload 和源文件列表。只有服务端确认接收后才
// 删除 manifest 与样本，因此网络重试和进程重启都会重用完全相同的 report_id。
package spool

import (
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/xugou/agent/pkg/model"
)

const (
	DefaultMaxBytes           int64 = 64 * 1024 * 1024
	DefaultMaxEntries               = 10_000
	DefaultMaxSamples               = 100
	DefaultMaxCompressedBytes       = 512 * 1024
	inflightFileName                = "inflight.json"
	stateFileName                   = "state.json"
)

type Options struct {
	Dir        string
	MaxBytes   int64
	MaxEntries int
}

type Stats struct {
	Samples        int
	Bytes          int64
	DroppedSamples uint64
	Inflight       bool
}

type Store struct {
	mu         sync.Mutex
	dir        string
	maxBytes   int64
	maxEntries int
}

type sampleRecord struct {
	AgentVersion          string                   `json:"agent_version,omitempty"`
	Hostname              string                   `json:"hostname"`
	IPAddresses           []string                 `json:"ip_addresses,omitempty"`
	OS                    string                   `json:"os,omitempty"`
	Version               string                   `json:"version,omitempty"`
	BootTime              int64                    `json:"boot_time,omitempty"`
	KeepaliveSeconds      int                      `json:"keepalive_seconds,omitempty"`
	ReportIntervalSeconds int                      `json:"report_interval_seconds,omitempty"`
	Sample                *model.AgentReportSample `json:"sample"`
}

type inflightRecord struct {
	Files  []string           `json:"files"`
	Report *model.AgentReport `json:"report"`
}

type persistedState struct {
	DroppedSamples uint64 `json:"dropped_samples"`
}

func Open(options Options) (*Store, error) {
	if strings.TrimSpace(options.Dir) == "" {
		return nil, errors.New("spool 目录为空")
	}
	if options.MaxBytes <= 0 {
		options.MaxBytes = DefaultMaxBytes
	}
	if options.MaxEntries <= 0 {
		options.MaxEntries = DefaultMaxEntries
	}
	if err := os.MkdirAll(options.Dir, 0o700); err != nil {
		return nil, fmt.Errorf("创建 spool 目录失败: %w", err)
	}
	if err := os.Chmod(options.Dir, 0o700); err != nil {
		return nil, fmt.Errorf("设置 spool 目录权限失败: %w", err)
	}
	store := &Store{
		dir:        options.Dir,
		maxBytes:   options.MaxBytes,
		maxEntries: options.MaxEntries,
	}
	if err := store.recoverAcked(); err != nil {
		return nil, fmt.Errorf("恢复已确认 spool 批次失败: %w", err)
	}
	if _, err := store.readInflight(); err != nil {
		return nil, fmt.Errorf("读取 spool inflight 失败: %w", err)
	}
	return store, nil
}

// Add 在采集成功后立即落盘。文件只包含公开系统元数据和指标，不包含 Agent Token。
func (s *Store) Add(info *model.SystemInfo) (uint64, error) {
	if info == nil {
		return 0, errors.New("采集样本为空")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	record := sampleRecord{
		AgentVersion:          info.AgentVersion,
		Hostname:              info.Hostname,
		IPAddresses:           append([]string(nil), info.IPAddresses...),
		OS:                    info.OS,
		Version:               info.Version,
		BootTime:              info.BootTime,
		KeepaliveSeconds:      info.Keepalive,
		ReportIntervalSeconds: info.ReportIntervalSeconds,
		Sample:                model.NewAgentReportSample(info),
	}
	data, err := json.Marshal(record)
	if err != nil {
		return 0, fmt.Errorf("序列化 spool 样本失败: %w", err)
	}
	name, err := newSampleFileName(info.Timestamp)
	if err != nil {
		return 0, err
	}
	if err := atomicWrite(filepath.Join(s.dir, name), data); err != nil {
		return 0, fmt.Errorf("写入 spool 样本失败: %w", err)
	}
	dropped, err := s.enforceBounds()
	if err != nil {
		return dropped, err
	}
	return dropped, nil
}

// Next 返回当前稳定 inflight；不存在时从最老样本生成一个新批次。
func (s *Store) Next(maxSamples, maxCompressedBytes int) (*model.AgentReport, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.recoverAcked(); err != nil {
		return nil, false, fmt.Errorf("清理已确认 spool 批次失败: %w", err)
	}

	if maxSamples <= 0 || maxSamples > DefaultMaxSamples {
		maxSamples = DefaultMaxSamples
	}
	if maxCompressedBytes <= 0 {
		maxCompressedBytes = DefaultMaxCompressedBytes
	}
	if existing, err := s.readInflight(); err != nil {
		return nil, false, err
	} else if existing != nil {
		return existing.Report, true, nil
	}

	files, err := s.sampleFiles()
	if err != nil {
		return nil, false, err
	}
	if len(files) == 0 {
		return nil, false, nil
	}

	reportID, err := newUUID()
	if err != nil {
		return nil, false, err
	}
	selected := make([]string, 0, min(maxSamples, len(files)))
	var report *model.AgentReport
	for _, name := range files {
		if len(selected) >= maxSamples {
			break
		}
		record, err := s.readSample(name)
		if err != nil {
			return nil, false, err
		}
		candidate := append([]string(nil), selected...)
		candidate = append(candidate, name)
		candidateReport, err := s.buildReport(reportID, candidate)
		if err != nil {
			return nil, false, err
		}
		size, err := compressedSize(candidateReport)
		if err != nil {
			return nil, false, err
		}
		if size > maxCompressedBytes {
			if len(selected) == 0 {
				return nil, false, fmt.Errorf("单条采样压缩后为 %d 字节，超过批次上限 %d", size, maxCompressedBytes)
			}
			break
		}
		_ = record // buildReport 会重新读取，保留此处让损坏样本尽早失败。
		selected = candidate
		report = candidateReport
	}
	if report == nil {
		return nil, false, nil
	}

	inflight := inflightRecord{Files: selected, Report: report}
	data, err := json.Marshal(inflight)
	if err != nil {
		return nil, false, fmt.Errorf("序列化 inflight 失败: %w", err)
	}
	if err := atomicWrite(filepath.Join(s.dir, inflightFileName), data); err != nil {
		return nil, false, fmt.Errorf("写入 inflight 失败: %w", err)
	}
	return report, true, nil
}

// Ack 删除已被服务端接受的稳定批次。reportID 不匹配时保持所有文件不变。
func (s *Store) Ack(reportID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	inflight, err := s.readInflight()
	if err != nil {
		return err
	}
	if inflight == nil {
		return nil
	}
	if inflight.Report == nil || inflight.Report.ReportID != reportID {
		return errors.New("spool ack 的 report_id 与 inflight 不一致")
	}
	ackedName := "acked-" + reportID + ".json"
	if err := os.Rename(
		filepath.Join(s.dir, inflightFileName),
		filepath.Join(s.dir, ackedName),
	); err != nil {
		return fmt.Errorf("提交 inflight manifest 失败: %w", err)
	}
	if err := syncDir(s.dir); err != nil {
		return err
	}
	return s.recoverAcked()
}

func (s *Store) Stats() (Stats, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	files, err := s.sampleFiles()
	if err != nil {
		return Stats{}, err
	}
	var bytes int64
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return Stats{}, err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return Stats{}, err
		}
		bytes += info.Size()
	}
	state, err := s.readState()
	if err != nil {
		return Stats{}, err
	}
	inflight, err := s.readInflight()
	if err != nil {
		return Stats{}, err
	}
	return Stats{
		Samples:        len(files),
		Bytes:          bytes,
		DroppedSamples: state.DroppedSamples,
		Inflight:       inflight != nil,
	}, nil
}

func (s *Store) buildReport(reportID string, files []string) (*model.AgentReport, error) {
	records := make([]sampleRecord, 0, len(files))
	for _, name := range files {
		record, err := s.readSample(name)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	latest := records[len(records)-1]
	samples := make([]*model.AgentReportSample, 0, len(records))
	for _, record := range records {
		samples = append(samples, record.Sample)
	}
	return &model.AgentReport{
		ProtocolVersion:       4,
		AgentVersion:          latest.AgentVersion,
		ReportID:              reportID,
		Hostname:              latest.Hostname,
		IPAddresses:           latest.IPAddresses,
		OS:                    latest.OS,
		Version:               latest.Version,
		BootTime:              latest.BootTime,
		KeepaliveSeconds:      latest.KeepaliveSeconds,
		ReportIntervalSeconds: latest.ReportIntervalSeconds,
		Samples:               samples,
	}, nil
}

func (s *Store) enforceBounds() (uint64, error) {
	files, err := s.sampleFiles()
	if err != nil {
		return 0, err
	}
	protected := map[string]struct{}{}
	if inflight, err := s.readInflight(); err != nil {
		return 0, err
	} else if inflight != nil {
		for _, name := range inflight.Files {
			protected[name] = struct{}{}
		}
	}
	type fileEntry struct {
		name string
		size int64
	}
	entries := make([]fileEntry, 0, len(files))
	var total int64
	directoryEntries, err := os.ReadDir(s.dir)
	if err != nil {
		return 0, err
	}
	for _, entry := range directoryEntries {
		if entry.IsDir() || isSampleFile(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return 0, err
		}
		total += info.Size()
	}
	for _, name := range files {
		info, err := os.Stat(filepath.Join(s.dir, name))
		if err != nil {
			return 0, err
		}
		entries = append(entries, fileEntry{name: name, size: info.Size()})
		total += info.Size()
	}
	var dropped uint64
	for _, entry := range entries {
		if len(entries)-int(dropped) <= s.maxEntries && total <= s.maxBytes {
			break
		}
		if _, ok := protected[entry.name]; ok {
			continue
		}
		if err := os.Remove(filepath.Join(s.dir, entry.name)); err != nil && !os.IsNotExist(err) {
			return dropped, err
		}
		total -= entry.size
		dropped++
	}
	if dropped > 0 {
		state, err := s.readState()
		if err != nil {
			return dropped, err
		}
		state.DroppedSamples += dropped
		data, err := json.Marshal(state)
		if err != nil {
			return dropped, err
		}
		if err := atomicWrite(filepath.Join(s.dir, stateFileName), data); err != nil {
			return dropped, err
		}
	}
	return dropped, nil
}

func (s *Store) readSample(name string) (sampleRecord, error) {
	if !isSampleFile(name) {
		return sampleRecord{}, fmt.Errorf("非法样本文件名: %q", name)
	}
	raw, err := os.ReadFile(filepath.Join(s.dir, name))
	if err != nil {
		return sampleRecord{}, fmt.Errorf("读取样本 %q 失败: %w", name, err)
	}
	var record sampleRecord
	if err := strictJSON(raw, &record); err != nil {
		return sampleRecord{}, fmt.Errorf("解析样本 %q 失败: %w", name, err)
	}
	if record.Sample == nil || record.Sample.CollectedAt == "" {
		return sampleRecord{}, fmt.Errorf("样本 %q 缺少 collected_at", name)
	}
	return record, nil
}

func (s *Store) readInflight() (*inflightRecord, error) {
	raw, err := os.ReadFile(filepath.Join(s.dir, inflightFileName))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var record inflightRecord
	if err := strictJSON(raw, &record); err != nil {
		return nil, err
	}
	if record.Report == nil || record.Report.ReportID == "" || len(record.Files) == 0 {
		return nil, errors.New("inflight manifest 不完整")
	}
	for _, name := range record.Files {
		if !isSampleFile(name) {
			return nil, fmt.Errorf("inflight 包含非法文件名: %q", name)
		}
		if _, err := os.Stat(filepath.Join(s.dir, name)); err != nil {
			return nil, fmt.Errorf("inflight 引用样本 %q 失败: %w", name, err)
		}
	}
	return &record, nil
}

func (s *Store) readState() (persistedState, error) {
	raw, err := os.ReadFile(filepath.Join(s.dir, stateFileName))
	if os.IsNotExist(err) {
		return persistedState{}, nil
	}
	if err != nil {
		return persistedState{}, err
	}
	var state persistedState
	if err := strictJSON(raw, &state); err != nil {
		return persistedState{}, err
	}
	return state, nil
}

// recoverAcked 完成两阶段 Ack 的清理。inflight 先原子改名为 acked manifest，
// 因此即使进程在逐个删除样本时退出，重启也会继续清理而不是换 report_id 重发。
func (s *Store) recoverAcked() error {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasPrefix(name, "acked-") || !strings.HasSuffix(name, ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(s.dir, name))
		if err != nil {
			return err
		}
		var record inflightRecord
		if err := strictJSON(raw, &record); err != nil {
			return fmt.Errorf("解析已确认 manifest %q 失败: %w", name, err)
		}
		for _, sampleName := range record.Files {
			if !isSampleFile(sampleName) {
				return fmt.Errorf("已确认 manifest %q 包含非法样本文件名", name)
			}
			if err := os.Remove(filepath.Join(s.dir, sampleName)); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
		if err := os.Remove(filepath.Join(s.dir, name)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return syncDir(s.dir)
}

func (s *Store) sampleFiles() ([]string, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, err
	}
	files := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && isSampleFile(entry.Name()) {
			files = append(files, entry.Name())
		}
	}
	sort.Strings(files)
	return files, nil
}

func strictJSON(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("JSON 包含多余内容")
	}
	return nil
}

func compressedSize(value any) (int, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return 0, err
	}
	var buffer bytes.Buffer
	writer, err := gzip.NewWriterLevel(&buffer, gzip.BestSpeed)
	if err != nil {
		return 0, err
	}
	if _, err := writer.Write(data); err != nil {
		return 0, err
	}
	if err := writer.Close(); err != nil {
		return 0, err
	}
	return buffer.Len(), nil
}

func newSampleFileName(timestamp time.Time) (string, error) {
	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("生成样本 ID 失败: %w", err)
	}
	return fmt.Sprintf("sample-%020d-%s.json", timestamp.UnixNano(), hex.EncodeToString(random)), nil
}

func newUUID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("生成 report_id 失败: %w", err)
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}

func isSampleFile(name string) bool {
	return strings.HasPrefix(name, "sample-") && strings.HasSuffix(name, ".json") && filepath.Base(name) == name
}

func atomicWrite(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".spool-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	return syncDir(dir)
}

func syncDir(dir string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	handle, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer handle.Close()
	return handle.Sync()
}
