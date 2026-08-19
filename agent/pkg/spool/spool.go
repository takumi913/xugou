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
	"encoding/base64"
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

	"github.com/xugou/agent/pkg/metricblock"
	"github.com/xugou/agent/pkg/model"
)

const (
	DefaultMaxBytes            int64 = 64 * 1024 * 1024
	DefaultMaxEntries                = 10_000
	DefaultMaxSamples                = 100
	DefaultMaxCompressedBytes        = 64 * 1024
	defaultBoundsCheckInterval       = 60
	inflightFileName                 = "inflight.json"
	stateFileName                    = "state.json"
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
	mu                   sync.Mutex
	dir                  string
	maxBytes             int64
	maxEntries           int
	addsSinceBoundsCheck int
	// rollupPoints 累积尚未落盘的分钟聚合点（minuteStart -> point）。
	// 进程重启即丢失，届时重传的聚合块会更短——服务端的单调守卫
	// （excluded.point_count >= 现有值）会拒绝它，已有的完整块不受影响，
	// 因此这里刻意不做持久化。
	rollupPoints map[int64]*metricblock.MinutePoint
	// now 便于测试注入时钟。
	now func() time.Time
	// discarded 记录启动时因结构不兼容而丢弃的文件，供调用方打日志。
	discarded []string
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
		dir:          options.Dir,
		maxBytes:     options.MaxBytes,
		maxEntries:   options.MaxEntries,
		rollupPoints: make(map[int64]*metricblock.MinutePoint),
		now:          time.Now,
	}
	// 先清掉旧版本残留的、当前结构解析不了的文件，再走正常恢复流程。
	// 顺序很重要：v4 的 inflight/样本会让下面每一步都直接报错退出。
	if err := store.purgeIncompatible(); err != nil {
		return nil, fmt.Errorf("清理不兼容 spool 文件失败: %w", err)
	}
	if err := store.recoverAcked(); err != nil {
		return nil, fmt.Errorf("恢复已确认 spool 批次失败: %w", err)
	}
	// inflight 在这一步只做健全性检查。它引用的样本可能已被上面的清理删掉，
	// 那种情况下丢掉 manifest 重新组批即可，不值得让 Agent 起不来。
	if _, err := store.readInflight(); err != nil {
		if removeErr := os.Remove(filepath.Join(store.dir, inflightFileName)); removeErr != nil &&
			!os.IsNotExist(removeErr) {
			return nil, fmt.Errorf("丢弃损坏的 spool inflight 失败: %w", removeErr)
		}
		store.discarded = append(store.discarded, inflightFileName)
	}
	if _, err := store.enforceBounds(); err != nil {
		return nil, fmt.Errorf("收敛 spool 容量失败: %w", err)
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
	// 秒级采集下每次都扫描并排序整个目录会随断网时长持续放大开销。
	// 默认每分钟收敛一次容量；小型测试/显式小队列仍逐条严格收敛。
	s.addsSinceBoundsCheck++
	if s.addsSinceBoundsCheck < defaultBoundsCheckInterval &&
		s.maxEntries >= defaultBoundsCheckInterval {
		return 0, nil
	}
	s.addsSinceBoundsCheck = 0
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

	buckets, discarded, err := s.collectBuckets(files, maxSamples)
	if err != nil {
		return nil, false, err
	}
	if len(buckets) == 0 {
		// 只有当前这一分钟的样本，等它写满再组批
		return nil, false, nil
	}

	reportID, err := newUUID()
	if err != nil {
		return nil, false, err
	}

	// 逐桶加入，直到压缩后超过批次上限。桶是编码的最小单位，
	// 按桶而非按条试探可以把编码次数从 O(样本数) 降到 O(桶数)。
	var (
		report   *model.AgentReport
		selected []string
		accepted []*sampleBucket
	)
	for i, bucket := range buckets {
		candidate := append(append([]*sampleBucket(nil), accepted...), bucket)
		candidateReport, err := s.buildReport(reportID, candidate)
		if err != nil {
			return nil, false, err
		}
		size, err := compressedSize(candidateReport)
		if err != nil {
			return nil, false, err
		}
		if size > maxCompressedBytes {
			if i == 0 {
				return nil, false, fmt.Errorf(
					"单个分钟块压缩后为 %d 字节，超过批次上限 %d", size, maxCompressedBytes)
			}
			break
		}
		accepted = candidate
		report = candidateReport
	}
	if report == nil {
		return nil, false, nil
	}
	// 无法解析的样本文件一并纳入 Ack 范围，避免坏文件永久堵住队列
	selected = append(selected, discarded...)
	for _, bucket := range accepted {
		selected = append(selected, bucket.files...)
	}

	// 只有确定进入本批次的桶才计入聚合累积器
	s.mergeRollupPoints(accepted)
	if blocks, err := s.buildRollupBlocks(); err != nil {
		return nil, false, err
	} else {
		report.Blocks = append(report.Blocks, blocks...)
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

// sampleBucket 是一个分钟桶内的全部样本，块编码的最小单位。
type sampleBucket struct {
	start   int64
	files   []string
	samples []*model.AgentReportSample
	latest  sampleRecord
}

// collectBuckets 按分钟桶归拢待发样本，只返回【已完整】的桶——
// 当前这一分钟仍在写入，留到下一轮再组批，否则会先发半个块、
// 下一轮再发完整块，白白多写一次。
//
// 第二个返回值是时间戳无法解析的样本文件：它们不进任何桶，但仍要纳入
// Ack 范围，否则一个坏文件会永久堵住队列。
func (s *Store) collectBuckets(files []string, maxSamples int) ([]*sampleBucket, []string, error) {
	cutoff := metricblock.BucketStartFor(s.now().Unix(), 1)
	var (
		buckets   []*sampleBucket
		discarded []string
		byStart   = make(map[int64]*sampleBucket)
		total     int
	)
	for _, name := range files {
		record, err := s.readSample(name)
		if err != nil {
			return nil, nil, err
		}
		if record.Sample == nil {
			discarded = append(discarded, name)
			continue
		}
		ts, err := time.Parse(time.RFC3339Nano, record.Sample.CollectedAt)
		if err != nil {
			discarded = append(discarded, name)
			continue
		}
		start := metricblock.BucketStartFor(ts.Unix(), 1)
		if start >= cutoff {
			// 文件名按时间有序，遇到当前分钟即可停止扫描
			break
		}
		bucket := byStart[start]
		if bucket == nil {
			// 上限只在【开启新桶】时检查：桶是块编码的原子单位，绝不能半途截断。
			// 若截断，Ack 会删掉已发的那部分，剩余样本下一轮组成同一桶的更短的块，
			// 而服务端的单调守卫会拒绝它 —— 那部分数据将永久丢失。
			// 代价是单批最多超出上限一个桶（1 Hz 采集下 ≤ 60 条），可接受。
			if total >= maxSamples {
				break
			}
			bucket = &sampleBucket{start: start}
			byStart[start] = bucket
			buckets = append(buckets, bucket)
		}
		bucket.files = append(bucket.files, name)
		bucket.samples = append(bucket.samples, record.Sample)
		bucket.latest = record
		total++
	}
	return buckets, discarded, nil
}

// buildReport 把若干完整分钟桶编码成 v5 上报信封。
func (s *Store) buildReport(reportID string, buckets []*sampleBucket) (*model.AgentReport, error) {
	if len(buckets) == 0 {
		return nil, errors.New("上报批次为空")
	}
	latest := buckets[len(buckets)-1].latest
	blocks := make([]*model.AgentReportBlock, 0, len(buckets))
	for _, bucket := range buckets {
		block, err := metricblock.Encode(bucket.start, bucket.samples)
		if err != nil {
			return nil, fmt.Errorf("编码 %d 分钟块失败: %w", bucket.start, err)
		}
		blocks = append(blocks, toReportBlock(block))
	}
	return &model.AgentReport{
		ProtocolVersion:       model.AgentReportProtocolVersion,
		AgentVersion:          latest.AgentVersion,
		ReportID:              reportID,
		Hostname:              latest.Hostname,
		IPAddresses:           latest.IPAddresses,
		OS:                    latest.OS,
		Version:               latest.Version,
		BootTime:              latest.BootTime,
		KeepaliveSeconds:      latest.KeepaliveSeconds,
		ReportIntervalSeconds: latest.ReportIntervalSeconds,
		Blocks:                blocks,
		Latest:                latest.Sample,
	}, nil
}

func toReportBlock(block *metricblock.Block) *model.AgentReportBlock {
	return &model.AgentReportBlock{
		Resolution:  block.Resolution,
		BucketStart: block.BucketStart,
		PointCount:  block.PointCount,
		Codec:       int(metricblock.CodecVersion),
		Data:        base64.StdEncoding.EncodeToString(block.Data),
	}
}

// mergeRollupPoints 把进入本批次的分钟桶聚合后并入累积器。
// 键是分钟起点，重复处理同一分钟是幂等的。
func (s *Store) mergeRollupPoints(buckets []*sampleBucket) {
	for _, bucket := range buckets {
		if point := metricblock.Aggregate(bucket.start, bucket.samples); point != nil {
			s.rollupPoints[bucket.start] = point
		}
	}
}

// buildRollupBlocks 为累积器里出现的每个小时生成一个聚合块，随后只保留
// 最新一个小时的点：更早的小时已经完整，不会再有新分钟加入。
//
// 当前小时的块每轮都会带着全部已知分钟重发一次（最多 60 点约 1.5 KB），
// 服务端按 (agent_id, 60, hourStart) upsert，越发越完整。
func (s *Store) buildRollupBlocks() ([]*model.AgentReportBlock, error) {
	if len(s.rollupPoints) == 0 {
		return nil, nil
	}
	byHour := make(map[int64][]*metricblock.MinutePoint)
	var latestHour int64
	for minute, point := range s.rollupPoints {
		hour := metricblock.BucketStartFor(minute, 60)
		byHour[hour] = append(byHour[hour], point)
		if hour > latestHour {
			latestHour = hour
		}
	}

	hours := make([]int64, 0, len(byHour))
	for hour := range byHour {
		hours = append(hours, hour)
	}
	sort.Slice(hours, func(i, j int) bool { return hours[i] < hours[j] })

	blocks := make([]*model.AgentReportBlock, 0, len(hours))
	for _, hour := range hours {
		points := byHour[hour]
		sort.Slice(points, func(i, j int) bool {
			return points[i].MinuteStart < points[j].MinuteStart
		})
		block, err := metricblock.EncodeRollup(hour, points)
		if err != nil {
			return nil, fmt.Errorf("编码 %d 小时聚合块失败: %w", hour, err)
		}
		blocks = append(blocks, toReportBlock(block))
	}

	for minute := range s.rollupPoints {
		if metricblock.BucketStartFor(minute, 60) != latestHour {
			delete(s.rollupPoints, minute)
		}
	}
	return blocks, nil
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

// Discarded 返回启动时丢弃的不兼容文件名，调用方可据此打一条升级提示日志。
func (s *Store) Discarded() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.discarded...)
}

// purgeIncompatible 删除当前 manifest/样本结构解析不了的残留文件。
//
// 升级路径上这是必需的：v4 的 inflight manifest 带 `samples` 字段，v5 的
// 严格解码器会直接拒绝，导致 Open 失败、进程起不来。manifest 里固化的
// 上报体在 v5 也已经没有意义（协议从 samples 换成了 blocks），丢掉只损失
// 一个 report_id；样本文件本身若还能解析就原样保留，下一轮重新组批。
//
// 只对【解码失败】动手：I/O 错误照常向上抛，不能把读不到的文件当成脏数据删掉。
func (s *Store) purgeIncompatible() error {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		isManifest := name == inflightFileName ||
			(strings.HasPrefix(name, "acked-") && strings.HasSuffix(name, ".json"))
		if !isManifest && !isSampleFile(name) {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(s.dir, name))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		var decodeErr error
		if isManifest {
			var record inflightRecord
			decodeErr = strictJSON(raw, &record)
		} else {
			var record sampleRecord
			decodeErr = strictJSON(raw, &record)
		}
		if decodeErr == nil {
			continue
		}
		if err := os.Remove(filepath.Join(s.dir, name)); err != nil && !os.IsNotExist(err) {
			return err
		}
		s.discarded = append(s.discarded, name)
	}
	if len(s.discarded) == 0 {
		return nil
	}
	return syncDir(s.dir)
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
