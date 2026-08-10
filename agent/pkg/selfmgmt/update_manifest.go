package selfmgmt

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	DefaultManifestName = "manifest.json"
	maxManifestBytes    = 1024 * 1024
	maxArtifactBytes    = 512 * 1024 * 1024
)

// ReleaseManifest 是签名覆盖的原始发布清单。签名存放在同 URL 的 .sig 文件中。
type ReleaseManifest struct {
	SchemaVersion int               `json:"schema_version"`
	Version       string            `json:"version"`
	Artifacts     []ReleaseArtifact `json:"artifacts"`
	ReleasedAt    string            `json:"released_at"`
}

// ReleaseChannel 是最后上传的签名通道指针，指向不可变版本清单。
type ReleaseChannel struct {
	SchemaVersion  int    `json:"schema_version"`
	Channel        string `json:"channel"`
	Version        string `json:"version"`
	ManifestURL    string `json:"manifest_url"`
	ManifestSHA256 string `json:"manifest_sha256"`
	ReleasedAt     string `json:"released_at"`
}

// signedDocumentEnvelope 把签名与被签名载荷放在同一个可原子替换的对象中。
// 不可变 Manifest 仍兼容同 URL 的 .sig；可变 Channel 必须使用此封装。
type signedDocumentEnvelope struct {
	SchemaVersion int    `json:"schema_version"`
	PayloadBase64 string `json:"payload_base64"`
	Signature     string `json:"signature"`
}

type ReleaseArtifact struct {
	OS     string `json:"os"`
	Arch   string `json:"arch"`
	URL    string `json:"url"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type VerifiedRelease struct {
	Manifest ReleaseManifest
	Artifact ReleaseArtifact
	URL      string
}

func ManifestURL(base string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(base), "/")
	if strings.HasSuffix(trimmed, ".json") {
		return trimmed
	}
	return trimmed + "/" + DefaultManifestName
}

func decodeBase64(value string) ([]byte, error) {
	value = strings.TrimSpace(value)
	for _, encoding := range []*base64.Encoding{
		base64.StdEncoding,
		base64.RawStdEncoding,
		base64.URLEncoding,
		base64.RawURLEncoding,
	} {
		decoded, err := encoding.DecodeString(value)
		if err == nil {
			return decoded, nil
		}
	}
	return nil, errors.New("不是合法 Base64")
}

func validateDownloadURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" {
		return nil, fmt.Errorf("下载地址无效: %q", raw)
	}
	if parsed.User != nil {
		return nil, errors.New("下载地址不得包含用户凭据")
	}
	if parsed.Scheme == "https" {
		return parsed, nil
	}
	host := parsed.Hostname()
	if parsed.Scheme == "http" && (host == "localhost" || net.ParseIP(host).IsLoopback()) {
		return parsed, nil
	}
	return nil, errors.New("发布下载必须使用 HTTPS")
}

func newDownloadClient() *http.Client {
	return &http.Client{
		Timeout: downloadTimeout,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("下载重定向次数过多")
			}
			if _, err := validateDownloadURL(request.URL.String()); err != nil {
				return err
			}
			return nil
		},
	}
}

func fetchLimited(client *http.Client, rawURL string, maximum int64) ([]byte, error) {
	if _, err := validateDownloadURL(rawURL); err != nil {
		return nil, err
	}
	request, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("创建下载请求失败: %w", err)
	}
	request.Header.Set("Accept", "application/json, text/plain;q=0.9")
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("下载失败: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("下载失败: 服务器返回 %s", response.Status)
	}
	if response.ContentLength > maximum {
		return nil, fmt.Errorf("下载内容超过上限 %d 字节", maximum)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maximum+1))
	if err != nil {
		return nil, fmt.Errorf("读取下载内容失败: %w", err)
	}
	if int64(len(payload)) > maximum {
		return nil, fmt.Errorf("下载内容超过上限 %d 字节", maximum)
	}
	return payload, nil
}

func fetchSignedDocument(client *http.Client, documentURL string, publicKey ed25519.PublicKey) ([]byte, error) {
	payload, err := fetchLimited(client, documentURL, maxManifestBytes)
	if err != nil {
		return nil, err
	}
	var envelopeProbe struct {
		PayloadBase64 string `json:"payload_base64"`
		Signature     string `json:"signature"`
	}
	if json.Unmarshal(payload, &envelopeProbe) == nil &&
		(envelopeProbe.PayloadBase64 != "" || envelopeProbe.Signature != "") {
		var envelope signedDocumentEnvelope
		if err := decodeStrictJSON(payload, &envelope, "签名文档封装"); err != nil {
			return nil, err
		}
		if envelope.SchemaVersion != 1 {
			return nil, errors.New("签名文档封装版本无效")
		}
		signedPayload, err := decodeBase64(envelope.PayloadBase64)
		if err != nil || len(signedPayload) == 0 || len(signedPayload) > maxManifestBytes {
			return nil, errors.New("签名文档载荷格式无效")
		}
		signature, err := decodeBase64(envelope.Signature)
		if err != nil || len(signature) != ed25519.SignatureSize {
			return nil, errors.New("签名格式无效")
		}
		if !ed25519.Verify(publicKey, signedPayload, signature) {
			return nil, errors.New("签名校验失败")
		}
		return signedPayload, nil
	}
	signatureText, err := fetchLimited(client, documentURL+".sig", 4096)
	if err != nil {
		return nil, fmt.Errorf("获取签名失败: %w", err)
	}
	signature, err := decodeBase64(string(signatureText))
	if err != nil || len(signature) != ed25519.SignatureSize {
		return nil, errors.New("签名格式无效")
	}
	if !ed25519.Verify(publicKey, payload, signature) {
		return nil, errors.New("签名校验失败")
	}
	return payload, nil
}

func decodeStrictJSON(payload []byte, destination any, label string) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("%s格式无效: %w", label, err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return fmt.Errorf("%s包含多余 JSON 内容", label)
	}
	return nil
}

// FetchVerifiedRelease 校验通道指针和不可变清单的 Ed25519 签名，再选择当前平台产物。
func FetchVerifiedRelease(manifestURL, publicKeyBase64, goos, goarch string) (VerifiedRelease, error) {
	manifestURL = ManifestURL(manifestURL)
	publicKey, err := decodeBase64(publicKeyBase64)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return VerifiedRelease{}, errors.New("升级公钥配置无效")
	}
	client := newDownloadClient()
	documentBytes, err := fetchSignedDocument(client, manifestURL, ed25519.PublicKey(publicKey))
	if err != nil {
		return VerifiedRelease{}, fmt.Errorf("获取签名发布文档失败: %w", err)
	}

	var envelope struct {
		ManifestURL string `json:"manifest_url"`
	}
	if err := json.Unmarshal(documentBytes, &envelope); err != nil {
		return VerifiedRelease{}, fmt.Errorf("发布文档格式无效: %w", err)
	}
	manifestBytes := documentBytes
	if envelope.ManifestURL != "" {
		var channel ReleaseChannel
		if err := decodeStrictJSON(documentBytes, &channel, "升级通道指针"); err != nil {
			return VerifiedRelease{}, err
		}
		if channel.SchemaVersion != 1 || (channel.Channel != "stable" && channel.Channel != "dev") {
			return VerifiedRelease{}, errors.New("升级通道指针元数据无效")
		}
		if _, ok := parseSemver(channel.Version); !ok || len(channel.ManifestSHA256) != sha256.Size*2 {
			return VerifiedRelease{}, errors.New("升级通道指针版本或摘要无效")
		}
		if _, err := hex.DecodeString(channel.ManifestSHA256); err != nil {
			return VerifiedRelease{}, errors.New("升级通道指针摘要无效")
		}
		if _, err := time.Parse(time.RFC3339, channel.ReleasedAt); err != nil {
			return VerifiedRelease{}, errors.New("升级通道指针发布时间无效")
		}
		resolved, err := url.Parse(manifestURL)
		if err != nil {
			return VerifiedRelease{}, errors.New("升级通道地址无效")
		}
		manifestReference, err := url.Parse(channel.ManifestURL)
		if err != nil {
			return VerifiedRelease{}, errors.New("升级清单地址无效")
		}
		manifestURL = resolved.ResolveReference(manifestReference).String()
		if _, err := validateDownloadURL(manifestURL); err != nil {
			return VerifiedRelease{}, err
		}
		manifestBytes, err = fetchSignedDocument(client, manifestURL, ed25519.PublicKey(publicKey))
		if err != nil {
			return VerifiedRelease{}, fmt.Errorf("获取不可变升级清单失败: %w", err)
		}
		digest := sha256.Sum256(manifestBytes)
		if !strings.EqualFold(hex.EncodeToString(digest[:]), channel.ManifestSHA256) {
			return VerifiedRelease{}, errors.New("升级清单摘要与通道指针不一致")
		}
		var versionOnly struct {
			Version string `json:"version"`
		}
		if err := json.Unmarshal(manifestBytes, &versionOnly); err != nil || versionOnly.Version != channel.Version {
			return VerifiedRelease{}, errors.New("升级清单版本与通道指针不一致")
		}
	}

	var manifest ReleaseManifest
	if err := decodeStrictJSON(manifestBytes, &manifest, "升级清单"); err != nil {
		return VerifiedRelease{}, err
	}
	if manifest.SchemaVersion != 1 {
		return VerifiedRelease{}, fmt.Errorf("不支持的升级清单版本: %d", manifest.SchemaVersion)
	}
	if _, ok := parseSemver(manifest.Version); !ok {
		return VerifiedRelease{}, fmt.Errorf("升级版本号无效: %q", manifest.Version)
	}
	if _, err := time.Parse(time.RFC3339, manifest.ReleasedAt); err != nil {
		return VerifiedRelease{}, errors.New("升级发布时间无效")
	}
	if len(manifest.Artifacts) == 0 || len(manifest.Artifacts) > 32 {
		return VerifiedRelease{}, errors.New("升级产物列表数量无效")
	}

	base, _ := url.Parse(manifestURL)
	seen := make(map[string]struct{}, len(manifest.Artifacts))
	var selected *ReleaseArtifact
	var selectedURL string
	for index := range manifest.Artifacts {
		artifact := manifest.Artifacts[index]
		key := artifact.OS + "/" + artifact.Arch
		if _, exists := seen[key]; exists {
			return VerifiedRelease{}, fmt.Errorf("升级清单包含重复平台: %s", key)
		}
		seen[key] = struct{}{}
		if artifact.OS == "" || artifact.Arch == "" || artifact.Size < 4 || artifact.Size > maxArtifactBytes {
			return VerifiedRelease{}, fmt.Errorf("升级产物 %s 元数据无效", key)
		}
		if len(artifact.SHA256) != sha256.Size*2 {
			return VerifiedRelease{}, fmt.Errorf("升级产物 %s SHA-256 无效", key)
		}
		if _, err := hex.DecodeString(artifact.SHA256); err != nil {
			return VerifiedRelease{}, fmt.Errorf("升级产物 %s SHA-256 无效", key)
		}
		artifactRef, err := url.Parse(artifact.URL)
		if err != nil {
			return VerifiedRelease{}, fmt.Errorf("升级产物 %s URL 无效", key)
		}
		resolved := base.ResolveReference(artifactRef).String()
		if _, err := validateDownloadURL(resolved); err != nil {
			return VerifiedRelease{}, fmt.Errorf("升级产物 %s URL 无效: %w", key, err)
		}
		if artifact.OS == goos && artifact.Arch == goarch {
			copy := artifact
			selected = &copy
			selectedURL = resolved
		}
	}
	if selected == nil {
		return VerifiedRelease{}, fmt.Errorf("升级清单没有 %s/%s 产物", goos, goarch)
	}
	return VerifiedRelease{Manifest: manifest, Artifact: *selected, URL: selectedURL}, nil
}

// DownloadVerifiedArtifact 按清单大小和 SHA-256 校验下载产物，并 fsync 到目标目录。
func DownloadVerifiedArtifact(release VerifiedRelease, dir string) (string, error) {
	client := newDownloadClient()
	request, err := http.NewRequest(http.MethodGet, release.URL, nil)
	if err != nil {
		return "", fmt.Errorf("创建产物请求失败: %w", err)
	}
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("下载升级产物失败: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("下载升级产物失败: 服务器返回 %s", response.Status)
	}
	if response.ContentLength >= 0 && response.ContentLength != release.Artifact.Size {
		return "", errors.New("升级产物 Content-Length 与签名清单不一致")
	}

	temporary, err := os.CreateTemp(dir, ".xugou-agent-update-*")
	if err != nil {
		return "", fmt.Errorf("创建升级临时文件失败: %w", err)
	}
	path := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(path)
	}
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(temporary, hash), io.LimitReader(response.Body, release.Artifact.Size+1))
	if err != nil {
		cleanup()
		return "", fmt.Errorf("写入升级产物失败: %w", err)
	}
	if written != release.Artifact.Size {
		cleanup()
		return "", fmt.Errorf("升级产物大小不一致: got=%d want=%d", written, release.Artifact.Size)
	}
	if !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), release.Artifact.SHA256) {
		cleanup()
		return "", errors.New("升级产物 SHA-256 校验失败")
	}
	if err := temporary.Sync(); err != nil {
		cleanup()
		return "", fmt.Errorf("同步升级产物失败: %w", err)
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("关闭升级产物失败: %w", err)
	}
	if err := ValidateBinaryFile(path); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("升级产物格式校验失败: %w", err)
	}
	return filepath.Clean(path), nil
}
