// Package selfmgmt 提供 Agent 自管理（升级/卸载/状态）所需的纯函数与系统操作封装。
package selfmgmt

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

const (
	// AgentName Agent 名称，与安装脚本 install-agent.sh 保持一致
	AgentName = "xugou-agent"
	// DefaultDownloadBase 旧版 latest 分发地址，保留给旧 Agent 与安装脚本。
	DefaultDownloadBase = "https://dl.xugou.mdzz.uk/latest"
	// DefaultReleaseChannel 是原子切换的稳定通道指针。
	DefaultReleaseChannel = "https://dl.xugou.mdzz.uk/channels/stable.json"
	// ServiceName systemd 服务名
	ServiceName = "xugou-agent"
	// ServiceUnitPath systemd 服务单元文件路径（与 install-agent.sh 保持一致）
	ServiceUnitPath = "/etc/systemd/system/xugou-agent.service"
)

// BinaryName 按操作系统与架构拼接分发产物文件名，
// 与 .github/workflows/build.yml 的产物命名保持一致。
func BinaryName(goos, goarch string) string {
	name := fmt.Sprintf("%s-%s-%s", AgentName, goos, goarch)
	if goos == "windows" {
		name += ".exe"
	}
	return name
}

// CheckBinaryMagic 校验可执行文件魔数（ELF / Mach-O / PE）。
// header 至少需要 4 字节。
func CheckBinaryMagic(header []byte) error {
	if len(header) < 4 {
		return errors.New("文件过短，无法识别文件类型")
	}
	// ELF
	if header[0] == 0x7f && header[1] == 'E' && header[2] == 'L' && header[3] == 'F' {
		return nil
	}
	// Mach-O（32/64 位、大小端、以及 Fat/Universal）
	machoMagics := [][4]byte{
		{0xfe, 0xed, 0xfa, 0xce}, // MH_MAGIC
		{0xce, 0xfa, 0xed, 0xfe}, // MH_CIGAM
		{0xfe, 0xed, 0xfa, 0xcf}, // MH_MAGIC_64
		{0xcf, 0xfa, 0xed, 0xfe}, // MH_CIGAM_64
		{0xca, 0xfe, 0xba, 0xbe}, // FAT_MAGIC
		{0xbe, 0xba, 0xfe, 0xca}, // FAT_CIGAM
	}
	for _, m := range machoMagics {
		if header[0] == m[0] && header[1] == m[1] && header[2] == m[2] && header[3] == m[3] {
			return nil
		}
	}
	// PE (Windows)
	if header[0] == 'M' && header[1] == 'Z' {
		return nil
	}
	return errors.New("不是可识别的可执行文件（非 ELF/Mach-O/PE 格式）")
}

// CompareVersions 比较两个版本号（支持 v 前缀、语义化版本与预发布后缀）。
// 返回 -1/0/1 表示 a 小于/等于/大于 b；当任一版本无法按语义化版本解析时 ok 为 false。
func CompareVersions(a, b string) (result int, ok bool) {
	aVersion, aOK := parseSemver(a)
	bVersion, bOK := parseSemver(b)
	if !aOK || !bOK {
		return 0, false
	}
	for index := range aVersion.core {
		if aVersion.core[index] < bVersion.core[index] {
			return -1, true
		}
		if aVersion.core[index] > bVersion.core[index] {
			return 1, true
		}
	}
	if len(aVersion.prerelease) == 0 && len(bVersion.prerelease) == 0 {
		return 0, true
	}
	if len(aVersion.prerelease) == 0 {
		return 1, true
	}
	if len(bVersion.prerelease) == 0 {
		return -1, true
	}
	for index := 0; index < len(aVersion.prerelease) && index < len(bVersion.prerelease); index++ {
		result := comparePrereleaseIdentifier(
			aVersion.prerelease[index],
			bVersion.prerelease[index],
		)
		if result != 0 {
			return result, true
		}
	}
	if len(aVersion.prerelease) < len(bVersion.prerelease) {
		return -1, true
	}
	if len(aVersion.prerelease) > len(bVersion.prerelease) {
		return 1, true
	}
	return 0, true
}

type semanticVersion struct {
	core       [3]uint64
	prerelease []string
}

func validSemverIdentifier(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if !((character >= '0' && character <= '9') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= 'a' && character <= 'z') || character == '-') {
			return false
		}
	}
	return true
}

func parseSemver(v string) (semanticVersion, bool) {
	v = strings.TrimSpace(v)
	v = strings.TrimPrefix(v, "v")
	v = strings.TrimPrefix(v, "V")
	if v == "" {
		return semanticVersion{}, false
	}
	withoutBuild, build, hasBuild := strings.Cut(v, "+")
	if hasBuild {
		if strings.Contains(build, "+") {
			return semanticVersion{}, false
		}
		for identifier := range strings.SplitSeq(build, ".") {
			if !validSemverIdentifier(identifier) {
				return semanticVersion{}, false
			}
		}
	}
	base, pre, hasPrerelease := strings.Cut(withoutBuild, "-")
	segments := strings.Split(base, ".")
	if len(segments) != 3 {
		return semanticVersion{}, false
	}
	version := semanticVersion{}
	for index, segment := range segments {
		if segment == "" || (len(segment) > 1 && segment[0] == '0') {
			return semanticVersion{}, false
		}
		number, err := strconv.ParseUint(segment, 10, 64)
		if err != nil {
			return semanticVersion{}, false
		}
		version.core[index] = number
	}
	if hasPrerelease {
		for identifier := range strings.SplitSeq(pre, ".") {
			if !validSemverIdentifier(identifier) ||
				(allDigits(identifier) && len(identifier) > 1 && identifier[0] == '0') {
				return semanticVersion{}, false
			}
			version.prerelease = append(version.prerelease, identifier)
		}
	}
	return version, true
}

func allDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

func comparePrereleaseIdentifier(a, b string) int {
	aNumeric, bNumeric := allDigits(a), allDigits(b)
	if aNumeric && !bNumeric {
		return -1
	}
	if !aNumeric && bNumeric {
		return 1
	}
	if aNumeric && bNumeric {
		if len(a) < len(b) {
			return -1
		}
		if len(a) > len(b) {
			return 1
		}
	}
	// 历史发布曾使用 rc2/rc10 这类简写；同前缀的尾部数字按数值比较。
	aPrefix, aSuffix, aNatural := splitTrailingNumber(a)
	bPrefix, bSuffix, bNatural := splitTrailingNumber(b)
	if aNatural && bNatural && aPrefix == bPrefix {
		if len(aSuffix) < len(bSuffix) {
			return -1
		}
		if len(aSuffix) > len(bSuffix) {
			return 1
		}
		if aSuffix < bSuffix {
			return -1
		}
		if aSuffix > bSuffix {
			return 1
		}
		return 0
	}
	if a < b {
		return -1
	}
	if a > b {
		return 1
	}
	return 0
}

func splitTrailingNumber(value string) (prefix string, number string, ok bool) {
	index := len(value)
	for index > 0 && value[index-1] >= '0' && value[index-1] <= '9' {
		index--
	}
	if index == 0 || index == len(value) {
		return "", "", false
	}
	number = strings.TrimLeft(value[index:], "0")
	if number == "" {
		number = "0"
	}
	return value[:index], number, true
}

// ParseVersionOutput 从 `xugou-agent version` 命令输出中提取版本号。
// 兼容中文（"版本: x.y.z"）与英文（"Version: x.y.z"）输出，找不到时返回空串。
func ParseVersionOutput(output string) string {
	for line := range strings.SplitSeq(output, "\n") {
		line = strings.TrimSpace(line)
		for _, prefix := range []string{"版本:", "Version:", "version:"} {
			if rest, found := strings.CutPrefix(line, prefix); found {
				return strings.TrimSpace(rest)
			}
		}
	}
	return ""
}

// MaskToken 对令牌打码显示，仅保留首尾少量字符。
func MaskToken(token string) string {
	if token == "" {
		return ""
	}
	if len(token) <= 8 {
		return "****"
	}
	return token[:4] + "****" + token[len(token)-4:]
}

// ProbeTarget 从服务器 URL 推导出用于 TCP 连通性探测的 host:port 地址。
func ProbeTarget(serverURL string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(serverURL))
	if err != nil {
		return "", fmt.Errorf("服务器地址解析失败: %w", err)
	}
	if u.Host == "" {
		return "", fmt.Errorf("服务器地址缺少主机名: %q", serverURL)
	}
	port := u.Port()
	if port == "" {
		switch u.Scheme {
		case "https":
			port = "443"
		case "http", "":
			port = "80"
		default:
			return "", fmt.Errorf("不支持的协议: %q", u.Scheme)
		}
	}
	return net.JoinHostPort(u.Hostname(), port), nil
}
