package config

import (
	"crypto/md5"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// 配置下发协议常量（对齐 CF-Server-Monitor AGENT_CONFIG.md 的协议形态）。
// v3 在 v2 三键基础上引入可选的 update 指令键（0/1）：仅作为服务端触发自升级的
// 指令通道，不参与本地 MD5 计算（规范化串仍只含三键）、不落配置文件。
const (
	SchemaVersion      = 3
	MinSchemaVersion   = 2
	HeaderConfigSchema = "X-Agent-Config-Schema"
	HeaderConfigMd5    = "X-Agent-Config-Md5"
	// HeaderAgentVersion 上报请求携带的探针自身版本（服务端据此判断是否下发 update=1）
	HeaderAgentVersion = "X-Agent-Version"

	MinCollectInterval = 1
	MaxCollectInterval = 3600
	MinReportInterval  = 10
	MaxReportInterval  = 3600

	// maxConfigBodyBytes 服务端下发配置串的最大长度，超出整体丢弃
	maxConfigBodyBytes = 512
)

// allowedConfigKeys 键白名单：协议刻意不含 secret/URL/命令类字段，白名单外一律拒绝
var allowedConfigKeys = map[string]struct{}{
	"collect_interval": {},
	"report_interval":  {},
	"schema_version":   {},
	"update":           {},
}

// requiredConfigKeys 必须出现的键（update 为 v3 可选指令键）
var requiredConfigKeys = []string{
	"collect_interval",
	"report_interval",
	"schema_version",
}

// RemoteConfig 服务端下发并通过整体校验后的配置
type RemoteConfig struct {
	CollectInterval int
	ReportInterval  int
	// Update 服务端触发自升级指令（update=1）；不持久化，仅当次生效
	Update bool
}

// ValidateIntervals 校验采集/上报间隔值域：collect 1-3600，report 10-3600 且 >= collect
func ValidateIntervals(collect, report int) error {
	if collect < MinCollectInterval || collect > MaxCollectInterval {
		return fmt.Errorf("collect_interval 超出值域 [%d, %d]: %d", MinCollectInterval, MaxCollectInterval, collect)
	}
	if report < MinReportInterval || report > MaxReportInterval {
		return fmt.Errorf("report_interval 超出值域 [%d, %d]: %d", MinReportInterval, MaxReportInterval, report)
	}
	if report < collect {
		return fmt.Errorf("report_interval(%d) 不能小于 collect_interval(%d)", report, collect)
	}
	return nil
}

// NormalizedConfigString 生成规范化配置串。键按固定顺序、分隔符不可变，
// 服务端会回填客户端声明的 schema_version 对同一格式计算 MD5，两侧必须逐字节一致。
// update 指令键刻意排除在规范化串之外（仅指令通道，不参与 MD5 协商）。
func NormalizedConfigString(collect, report int) string {
	return fmt.Sprintf(
		"collect_interval=%d&report_interval=%d&schema_version=%d",
		collect, report, SchemaVersion,
	)
}

// MD5Hex 计算字符串的 MD5 十六进制小写摘要
func MD5Hex(s string) string {
	sum := md5.Sum([]byte(s))
	return hex.EncodeToString(sum[:])
}

// CurrentConfigMD5 计算当前内存配置的规范化 MD5（随配置热更新自动变化）
func CurrentConfigMD5() string {
	return MD5Hex(NormalizedConfigString(CollectInterval, ReportInterval))
}

// ParseRemoteConfig 解析并整体校验服务端下发的 application/x-www-form-urlencoded 配置串。
// 任何一处不合法（超长、未知键、重复键、换行/空格/百分号编码、值域越界）都整体丢弃。
func ParseRemoteConfig(body string) (*RemoteConfig, error) {
	if body == "" {
		return nil, errors.New("配置串为空")
	}
	if len(body) > maxConfigBodyBytes {
		return nil, fmt.Errorf("配置串超过 %d 字节: %d", maxConfigBodyBytes, len(body))
	}
	if strings.ContainsAny(body, " \t\r\n") {
		return nil, errors.New("配置串包含空白字符")
	}
	if strings.Contains(body, "%") {
		return nil, errors.New("配置串不接受百分号编码")
	}

	values := make(map[string]int, len(allowedConfigKeys))
	for pair := range strings.SplitSeq(body, "&") {
		key, rawValue, found := strings.Cut(pair, "=")
		if !found || key == "" || rawValue == "" {
			return nil, fmt.Errorf("非法键值对: %q", pair)
		}
		if _, allowed := allowedConfigKeys[key]; !allowed {
			return nil, fmt.Errorf("未知配置键: %q", key)
		}
		if _, dup := values[key]; dup {
			return nil, fmt.Errorf("重复配置键: %q", key)
		}
		value, err := strconv.Atoi(rawValue)
		if err != nil {
			return nil, fmt.Errorf("配置键 %q 的值不是整数: %q", key, rawValue)
		}
		values[key] = value
	}

	for _, key := range requiredConfigKeys {
		if _, ok := values[key]; !ok {
			return nil, fmt.Errorf("缺少配置键: %q", key)
		}
	}

	// 兼容 v2/v3：服务端回填客户端声明的版本，此处接受两者
	schema := values["schema_version"]
	if schema < MinSchemaVersion || schema > SchemaVersion {
		return nil, fmt.Errorf("schema_version 不匹配: %d", schema)
	}
	if err := ValidateIntervals(values["collect_interval"], values["report_interval"]); err != nil {
		return nil, err
	}

	// update 为可选指令键，仅接受 0/1
	update, hasUpdate := values["update"]
	if hasUpdate && update != 0 && update != 1 {
		return nil, fmt.Errorf("update 键的值非法: %d", update)
	}

	return &RemoteConfig{
		CollectInterval: values["collect_interval"],
		ReportInterval:  values["report_interval"],
		Update:          hasUpdate && update == 1,
	}, nil
}

// PersistIntervals 将采集/上报间隔原子写入 YAML 配置文件：
// 先读旧配置合并，再写同目录临时文件 + rename，避免半写状态。
// path 为空时跳过持久化（仅内存生效）。
func PersistIntervals(path string, collect, report int) error {
	if path == "" {
		return nil
	}
	if err := ValidateIntervals(collect, report); err != nil {
		return err
	}

	settings := map[string]any{}
	if raw, err := os.ReadFile(path); err == nil {
		if err := yaml.Unmarshal(raw, &settings); err != nil {
			return fmt.Errorf("解析现有配置文件失败: %w", err)
		}
		if settings == nil {
			settings = map[string]any{}
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("读取配置文件失败: %w", err)
	}

	settings["collect-interval"] = collect
	settings["report-interval"] = report

	data, err := yaml.Marshal(settings)
	if err != nil {
		return fmt.Errorf("序列化配置失败: %w", err)
	}

	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".xugou-agent-*.yaml.tmp")
	if err != nil {
		return fmt.Errorf("创建临时配置文件失败: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // rename 成功后 remove 静默失败，失败路径下清理残留

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("写入临时配置文件失败: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("刷盘临时配置文件失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("关闭临时配置文件失败: %w", err)
	}
	if err := os.Chmod(tmpPath, 0o600); err != nil {
		return fmt.Errorf("设置配置文件权限失败: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("原子替换配置文件失败: %w", err)
	}
	return nil
}
