package collector

import "testing"

func TestNormalizeProbeTargetValid(t *testing.T) {
	cases := map[string]string{
		"www.189.cn":         "www.189.cn:443",
		" www.baidu.com ":    "www.baidu.com:443",
		"example.com:80":     "example.com:80",
		"1.2.3.4":            "1.2.3.4:443",
		"1.2.3.4:8443":       "1.2.3.4:8443",
		"host-with_dash.com": "host-with_dash.com:443",
	}
	for input, want := range cases {
		if got := normalizeProbeTarget(input, "443"); got != want {
			t.Fatalf("normalizeProbeTarget(%q) = %q, want %q", input, got, want)
		}
	}
}

// TestDefaultPingTargetsAlreadyNormalized 保证默认目标表始终是合法的 host:port，
// resolvePingTargets 不再对其做规范化，这里守住这个前提。
func TestDefaultPingTargetsAlreadyNormalized(t *testing.T) {
	for line, target := range defaultPingTargets {
		if got := normalizeProbeTarget(target, defaultProbePort); got != target {
			t.Fatalf("默认目标 %s=%q 应已是规范化的 host:port，normalize 结果 %q", line, target, got)
		}
	}
}

func TestNormalizeProbeTargetInvalid(t *testing.T) {
	cases := []string{
		"",
		"   ",
		"https://example.com",
		"example.com:0",
		"example.com:65536",
		"example.com:abc",
		"example.com:",
		":443",
		"[2606:4700::1111]:443", // 不支持带方括号的 IPv6 字面量
		"2606:4700::1111",       // 多冒号有歧义
		"host with space",
		"host/path",
		"host?query=1",
		"user@host",
	}
	for _, input := range cases {
		if got := normalizeProbeTarget(input, "443"); got != "" {
			t.Fatalf("normalizeProbeTarget(%q) 应返回空串，实际 %q", input, got)
		}
	}
}
