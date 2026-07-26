package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestNormalizedConfigString(t *testing.T) {
	got := NormalizedConfigString(60, 300)
	want := "collect_interval=60&report_interval=300&schema_version=3"
	if got != want {
		t.Fatalf("规范化配置串不匹配: got %q, want %q", got, want)
	}
}

func TestMD5Hex(t *testing.T) {
	cases := map[string]string{
		"":    "d41d8cd98f00b204e9800998ecf8427e",
		"abc": "900150983cd24fb0d6963f7d28e17f72",
	}
	for input, want := range cases {
		if got := MD5Hex(input); got != want {
			t.Fatalf("MD5Hex(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestCurrentConfigMD5TracksVars(t *testing.T) {
	origCollect, origReport := CollectInterval, ReportInterval
	defer func() {
		CollectInterval, ReportInterval = origCollect, origReport
	}()

	CollectInterval, ReportInterval = 60, 300
	want := MD5Hex("collect_interval=60&report_interval=300&schema_version=3")
	if got := CurrentConfigMD5(); got != want {
		t.Fatalf("CurrentConfigMD5 = %q, want %q", got, want)
	}

	CollectInterval = 30
	if got := CurrentConfigMD5(); got == want {
		t.Fatal("配置变化后 MD5 应变化")
	}
}

func TestValidateIntervals(t *testing.T) {
	valid := [][2]int{{1, 10}, {60, 300}, {3600, 3600}, {10, 10}}
	for _, c := range valid {
		if err := ValidateIntervals(c[0], c[1]); err != nil {
			t.Fatalf("ValidateIntervals(%d, %d) 应通过: %v", c[0], c[1], err)
		}
	}

	invalid := [][2]int{
		{0, 300},    // collect 过小
		{3601, 300}, // collect 过大
		{60, 9},     // report 过小
		{60, 3601},  // report 过大
		{300, 60},   // report < collect
		{-1, -1},    // 负值
	}
	for _, c := range invalid {
		if err := ValidateIntervals(c[0], c[1]); err == nil {
			t.Fatalf("ValidateIntervals(%d, %d) 应失败", c[0], c[1])
		}
	}
}

func TestParseRemoteConfigValid(t *testing.T) {
	// v2（服务端回填旧版本号）仍可解析
	rc, err := ParseRemoteConfig("collect_interval=30&report_interval=120&schema_version=2")
	if err != nil {
		t.Fatalf("解析合法配置串失败: %v", err)
	}
	if rc.CollectInterval != 30 || rc.ReportInterval != 120 || rc.Update {
		t.Fatalf("解析结果不匹配: %+v", rc)
	}

	// v3 三键串（无 update 指令）
	rc, err = ParseRemoteConfig("collect_interval=30&report_interval=120&schema_version=3")
	if err != nil {
		t.Fatalf("解析 v3 配置串失败: %v", err)
	}
	if rc.CollectInterval != 30 || rc.ReportInterval != 120 || rc.Update {
		t.Fatalf("v3 解析结果不匹配: %+v", rc)
	}

	// 键顺序无关
	rc, err = ParseRemoteConfig("schema_version=2&report_interval=300&collect_interval=60")
	if err != nil {
		t.Fatalf("乱序键解析失败: %v", err)
	}
	if rc.CollectInterval != 60 || rc.ReportInterval != 300 {
		t.Fatalf("乱序键解析结果不匹配: %+v", rc)
	}
}

func TestParseRemoteConfigUpdateDirective(t *testing.T) {
	// update=1：触发自升级指令
	rc, err := ParseRemoteConfig("collect_interval=60&report_interval=300&schema_version=3&update=1")
	if err != nil {
		t.Fatalf("解析带 update=1 的配置串失败: %v", err)
	}
	if !rc.Update {
		t.Fatal("update=1 应置位 Update")
	}
	if rc.CollectInterval != 60 || rc.ReportInterval != 300 {
		t.Fatalf("update 指令不应影响间隔解析: %+v", rc)
	}

	// update=0：显式不触发
	rc, err = ParseRemoteConfig("collect_interval=60&report_interval=300&schema_version=3&update=0")
	if err != nil {
		t.Fatalf("解析带 update=0 的配置串失败: %v", err)
	}
	if rc.Update {
		t.Fatal("update=0 不应置位 Update")
	}

	// update 值非法：整体拒绝
	if _, err := ParseRemoteConfig("collect_interval=60&report_interval=300&schema_version=3&update=2"); err == nil {
		t.Fatal("update=2 应整体拒绝")
	}

	// 仅有 update 缺少必需键：整体拒绝
	if _, err := ParseRemoteConfig("update=1"); err == nil {
		t.Fatal("缺少必需键时应整体拒绝")
	}
}

func TestParseRemoteConfigRejects(t *testing.T) {
	cases := map[string]string{
		"空串":              "",
		"未知键":             "collect_interval=60&report_interval=300&schema_version=2&secret=x",
		"命令类键":            "collect_interval=60&report_interval=300&schema_version=2&exec=rm",
		"URL类键":           "collect_interval=60&report_interval=300&schema_version=2&worker_url=http",
		"重复键":             "collect_interval=60&collect_interval=61&report_interval=300&schema_version=2",
		"缺少键":             "collect_interval=60&schema_version=2",
		"换行":              "collect_interval=60&report_interval=300&schema_version=2\n",
		"空格":              "collect_interval=60&report_interval=300&schema_version=2 ",
		"百分号编码":           "collect_interval=60&report_interval=300&schema_version=%32",
		"非整数值":            "collect_interval=abc&report_interval=300&schema_version=2",
		"空值":              "collect_interval=&report_interval=300&schema_version=2",
		"schema不符":        "collect_interval=60&report_interval=300&schema_version=1",
		"collect越界":       "collect_interval=0&report_interval=300&schema_version=2",
		"report越界":        "collect_interval=60&report_interval=9&schema_version=2",
		"report小于collect": "collect_interval=300&report_interval=60&schema_version=2",
		"超512字节": "collect_interval=60&report_interval=300&schema_version=2&" +
			strings.Repeat("a", 512) + "=1",
	}
	for name, body := range cases {
		if _, err := ParseRemoteConfig(body); err == nil {
			t.Fatalf("用例 %q 应整体拒绝: %q", name, body)
		}
	}
}

func TestPersistIntervalsMergesExistingConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte("server: https://example.com\ntoken: abc\ncollect-interval: 60\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := PersistIntervals(path, 30, 120); err != nil {
		t.Fatalf("持久化失败: %v", err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	settings := map[string]any{}
	if err := yaml.Unmarshal(raw, &settings); err != nil {
		t.Fatalf("持久化结果不是合法 YAML: %v", err)
	}
	if settings["collect-interval"] != 30 || settings["report-interval"] != 120 {
		t.Fatalf("间隔未正确写入: %+v", settings)
	}
	if settings["server"] != "https://example.com" || settings["token"] != "abc" {
		t.Fatalf("已有配置项应保留: %+v", settings)
	}
}

func TestPersistIntervalsCreatesFileAndRejectsInvalid(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "new.yaml")

	if err := PersistIntervals(path, 60, 300); err != nil {
		t.Fatalf("新建配置文件失败: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("配置文件未创建: %v", err)
	}

	if err := PersistIntervals(path, 0, 300); err == nil {
		t.Fatal("非法间隔应拒绝持久化")
	}

	// path 为空时跳过持久化且不报错
	if err := PersistIntervals("", 60, 300); err != nil {
		t.Fatalf("空路径应跳过持久化: %v", err)
	}
}
