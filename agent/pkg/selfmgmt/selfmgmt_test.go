package selfmgmt

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestBinaryName(t *testing.T) {
	cases := []struct {
		goos, goarch, want string
	}{
		{"linux", "amd64", "xugou-agent-linux-amd64"},
		{"linux", "arm64", "xugou-agent-linux-arm64"},
		{"darwin", "arm64", "xugou-agent-darwin-arm64"},
		{"windows", "amd64", "xugou-agent-windows-amd64.exe"},
	}
	for _, c := range cases {
		if got := BinaryName(c.goos, c.goarch); got != c.want {
			t.Errorf("BinaryName(%q, %q) = %q, want %q", c.goos, c.goarch, got, c.want)
		}
	}
}

func TestCheckBinaryMagic(t *testing.T) {
	valid := [][]byte{
		{0x7f, 'E', 'L', 'F', 0x02}, // ELF
		{0xcf, 0xfa, 0xed, 0xfe},    // Mach-O 64 little-endian
		{0xfe, 0xed, 0xfa, 0xcf},    // Mach-O 64 big-endian
		{0xca, 0xfe, 0xba, 0xbe},    // Mach-O fat
		{'M', 'Z', 0x90, 0x00},      // PE
	}
	for i, h := range valid {
		if err := CheckBinaryMagic(h); err != nil {
			t.Errorf("case %d: expected valid magic, got error: %v", i, err)
		}
	}

	invalid := [][]byte{
		nil,
		{},
		{0x7f, 'E'},                 // 过短
		[]byte("#!/bin/bash\nexit"), // 脚本
		[]byte("<html>404</html>"),  // 错误页面
		{0x00, 0x00, 0x00, 0x00},
	}
	for i, h := range invalid {
		if err := CheckBinaryMagic(h); err == nil {
			t.Errorf("case %d: expected error for invalid magic %v", i, h)
		}
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b   string
		want   int
		wantOK bool
	}{
		{"1.0.0", "1.0.0", 0, true},
		{"v1.0.0", "1.0.0", 0, true},
		{"1.0.0", "1.0.1", -1, true},
		{"1.2.0", "1.1.9", 1, true},
		{"2.0", "2.0.0", 0, false},
		{"1.9.9", "2.0.0", -1, true},
		{"v10.0.0", "v9.0.0", 1, true},
		{"1.0.0-rc1", "1.0.0", -1, true},
		{"1.0.0", "1.0.0-rc1", 1, true},
		{"1.0.0-rc1", "1.0.0-rc2", -1, true},
		{"dev-abc123", "1.0.0", 0, false},
		{"", "1.0.0", 0, false},
		{"unknown", "unknown", 0, false},
	}
	for _, c := range cases {
		got, ok := CompareVersions(c.a, c.b)
		if ok != c.wantOK || (ok && got != c.want) {
			t.Errorf("CompareVersions(%q, %q) = (%d, %v), want (%d, %v)", c.a, c.b, got, ok, c.want, c.wantOK)
		}
	}

	fixturePath := filepath.Join("..", "..", "..", "contracts", "semver-cases.json")
	fixtureBytes, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read shared semver fixture: %v", err)
	}
	var fixtures []struct {
		A      string `json:"a"`
		B      string `json:"b"`
		Result *int   `json:"result"`
	}
	if err := json.Unmarshal(fixtureBytes, &fixtures); err != nil {
		t.Fatalf("parse shared semver fixture: %v", err)
	}
	for _, fixture := range fixtures {
		got, ok := CompareVersions(fixture.A, fixture.B)
		if fixture.Result == nil {
			if ok {
				t.Errorf("shared CompareVersions(%q, %q) = (%d, true), want invalid", fixture.A, fixture.B, got)
			}
			continue
		}
		if !ok || got != *fixture.Result {
			t.Errorf("shared CompareVersions(%q, %q) = (%d, %v), want %d", fixture.A, fixture.B, got, ok, *fixture.Result)
		}
	}
}

func TestParseVersionOutput(t *testing.T) {
	cases := []struct {
		output, want string
	}{
		{"Xugou Agent 版本信息:\n版本: 0.1.0\nGit 提交: abc\n构建日期: unknown\n", "0.1.0"},
		{"Version: v1.2.3\n", "v1.2.3"},
		{"version: 2.0.0", "2.0.0"},
		{"no version here", ""},
		{"", ""},
	}
	for _, c := range cases {
		if got := ParseVersionOutput(c.output); got != c.want {
			t.Errorf("ParseVersionOutput(%q) = %q, want %q", c.output, got, c.want)
		}
	}
}

func TestMaskToken(t *testing.T) {
	cases := []struct {
		token, want string
	}{
		{"", ""},
		{"short", "****"},
		{"12345678", "****"},
		{"xugou_maxln220_df8900585981ab775b36dcaaaee772d8", "xugo****72d8"},
	}
	for _, c := range cases {
		if got := MaskToken(c.token); got != c.want {
			t.Errorf("MaskToken(%q) = %q, want %q", c.token, got, c.want)
		}
	}
}

func TestProbeTarget(t *testing.T) {
	cases := []struct {
		url, want string
		wantErr   bool
	}{
		{"https://api.xugou.mdzz.uk", "api.xugou.mdzz.uk:443", false},
		{"http://localhost:8787", "localhost:8787", false},
		{"http://example.com", "example.com:80", false},
		{"https://example.com:8443/path", "example.com:8443", false},
		{"", "", true},
		{"ftp://example.com", "", true},
	}
	for _, c := range cases {
		got, err := ProbeTarget(c.url)
		if (err != nil) != c.wantErr {
			t.Errorf("ProbeTarget(%q) error = %v, wantErr %v", c.url, err, c.wantErr)
			continue
		}
		if !c.wantErr && got != c.want {
			t.Errorf("ProbeTarget(%q) = %q, want %q", c.url, got, c.want)
		}
	}
}

func TestValidateBinaryFile(t *testing.T) {
	dir := t.TempDir()

	elfPath := filepath.Join(dir, "elf-binary")
	if err := os.WriteFile(elfPath, append([]byte{0x7f, 'E', 'L', 'F'}, make([]byte, 64)...), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ValidateBinaryFile(elfPath); err != nil {
		t.Errorf("expected valid ELF file, got error: %v", err)
	}

	emptyPath := filepath.Join(dir, "empty")
	if err := os.WriteFile(emptyPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ValidateBinaryFile(emptyPath); err == nil {
		t.Error("expected error for empty file")
	}

	htmlPath := filepath.Join(dir, "error-page")
	if err := os.WriteFile(htmlPath, []byte("<html>Not Found</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ValidateBinaryFile(htmlPath); err == nil {
		t.Error("expected error for non-binary file")
	}

	if err := ValidateBinaryFile(filepath.Join(dir, "missing")); err == nil {
		t.Error("expected error for missing file")
	}
}

func TestSignedReleaseManifestAndArtifact(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	artifact := append([]byte{0x7f, 'E', 'L', 'F'}, []byte("signed agent body")...)
	digest := sha256.Sum256(artifact)
	var manifestBytes []byte
	var signature string
	var channelBytes []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/manifest.json":
			_, _ = w.Write(manifestBytes)
		case "/manifest.json.sig":
			_, _ = w.Write([]byte(signature))
		case "/channels/stable.json":
			_, _ = w.Write(channelBytes)
		case "/agent":
			w.Header().Set("Content-Length", fmt.Sprint(len(artifact)))
			_, _ = w.Write(artifact)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	manifest := ReleaseManifest{
		SchemaVersion: 1,
		Version:       "v2.0.0",
		ReleasedAt:    time.Now().UTC().Format(time.RFC3339),
		Artifacts: []ReleaseArtifact{{
			OS:     "linux",
			Arch:   "amd64",
			URL:    server.URL + "/agent",
			Size:   int64(len(artifact)),
			SHA256: hex.EncodeToString(digest[:]),
		}},
	}
	manifestBytes, err = json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, manifestBytes))
	manifestDigest := sha256.Sum256(manifestBytes)
	channelPayload, err := json.Marshal(ReleaseChannel{
		SchemaVersion:  1,
		Channel:        "stable",
		Version:        manifest.Version,
		ManifestURL:    server.URL + "/manifest.json",
		ManifestSHA256: hex.EncodeToString(manifestDigest[:]),
		ReleasedAt:     manifest.ReleasedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	channelBytes, err = json.Marshal(signedDocumentEnvelope{
		SchemaVersion: 1,
		PayloadBase64: base64.StdEncoding.EncodeToString(channelPayload),
		Signature: base64.StdEncoding.EncodeToString(
			ed25519.Sign(privateKey, channelPayload),
		),
	})
	if err != nil {
		t.Fatal(err)
	}
	release, err := FetchVerifiedRelease(
		server.URL+"/channels/stable.json",
		base64.StdEncoding.EncodeToString(publicKey),
		"linux",
		"amd64",
	)
	if err != nil {
		t.Fatalf("FetchVerifiedRelease failed: %v", err)
	}
	if release.Manifest.Version != "v2.0.0" || release.Artifact.Size != int64(len(artifact)) {
		t.Fatalf("unexpected release: %+v", release)
	}
	directManifestEnvelope, err := json.Marshal(signedDocumentEnvelope{
		SchemaVersion: 1,
		PayloadBase64: base64.StdEncoding.EncodeToString(manifestBytes),
		Signature:     signature,
	})
	if err != nil {
		t.Fatal(err)
	}
	legacyChannelBytes := channelBytes
	channelBytes = directManifestEnvelope
	if _, err := FetchVerifiedRelease(
		server.URL+"/channels/stable.json",
		base64.StdEncoding.EncodeToString(publicKey),
		"linux",
		"amd64",
	); err != nil {
		t.Fatalf("direct signed manifest envelope failed: %v", err)
	}
	channelBytes = legacyChannelBytes
	path, err := DownloadVerifiedArtifact(release, t.TempDir())
	if err != nil {
		t.Fatalf("DownloadVerifiedArtifact failed: %v", err)
	}
	downloaded, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(downloaded) != string(artifact) {
		t.Fatal("verified artifact content mismatch")
	}

	validChannelBytes := channelBytes
	var tamperedChannel signedDocumentEnvelope
	if err := json.Unmarshal(channelBytes, &tamperedChannel); err != nil {
		t.Fatal(err)
	}
	tamperedChannel.Signature = base64.StdEncoding.EncodeToString(
		make([]byte, ed25519.SignatureSize),
	)
	channelBytes, err = json.Marshal(tamperedChannel)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := FetchVerifiedRelease(
		server.URL+"/channels/stable.json",
		base64.StdEncoding.EncodeToString(publicKey),
		"linux",
		"amd64",
	); err == nil {
		t.Fatal("tampered embedded channel signature must be rejected")
	}
	channelBytes = validChannelBytes

	signature = base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	if _, err := FetchVerifiedRelease(
		server.URL+"/manifest.json",
		base64.StdEncoding.EncodeToString(publicKey),
		"linux",
		"amd64",
	); err == nil {
		t.Fatal("tampered signature must be rejected")
	}
}

func TestConcurrentChannelSwitchReturnsOnlyCompleteReleases(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	documents := map[string][]byte{}
	signatures := map[string][]byte{}
	var activeChannel atomic.Value
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/channels/stable.json" {
			_, _ = w.Write(activeChannel.Load().([]byte))
			return
		}
		if payload, ok := documents[r.URL.Path]; ok {
			_, _ = w.Write(payload)
			return
		}
		if signature, ok := signatures[r.URL.Path]; ok {
			_, _ = w.Write(signature)
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	makeRelease := func(version string) []byte {
		artifact := append([]byte{0x7f, 'E', 'L', 'F'}, []byte(version)...)
		artifactDigest := sha256.Sum256(artifact)
		manifestPath := "/releases/" + version + "/manifest.json"
		manifest, marshalErr := json.Marshal(ReleaseManifest{
			SchemaVersion: 1,
			Version:       version,
			ReleasedAt:    "2026-08-10T00:00:00Z",
			Artifacts: []ReleaseArtifact{{
				OS:     "linux",
				Arch:   "amd64",
				URL:    server.URL + "/releases/" + version + "/agent",
				Size:   int64(len(artifact)),
				SHA256: hex.EncodeToString(artifactDigest[:]),
			}},
		})
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		documents[manifestPath] = manifest
		signatures[manifestPath+".sig"] = []byte(base64.StdEncoding.EncodeToString(
			ed25519.Sign(privateKey, manifest),
		))
		manifestDigest := sha256.Sum256(manifest)
		channelPayload, marshalErr := json.Marshal(ReleaseChannel{
			SchemaVersion:  1,
			Channel:        "stable",
			Version:        version,
			ManifestURL:    server.URL + manifestPath,
			ManifestSHA256: hex.EncodeToString(manifestDigest[:]),
			ReleasedAt:     "2026-08-10T00:00:00Z",
		})
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		envelope, marshalErr := json.Marshal(signedDocumentEnvelope{
			SchemaVersion: 1,
			PayloadBase64: base64.StdEncoding.EncodeToString(channelPayload),
			Signature: base64.StdEncoding.EncodeToString(
				ed25519.Sign(privateKey, channelPayload),
			),
		})
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		return envelope
	}
	oldChannel := makeRelease("1.0.0")
	newChannel := makeRelease("2.0.0")
	activeChannel.Store(oldChannel)

	const readers = 8
	const readsPerReader = 10
	errorsSeen := make(chan error, readers*readsPerReader)
	var readersDone sync.WaitGroup
	for range readers {
		readersDone.Add(1)
		go func() {
			defer readersDone.Done()
			for range readsPerReader {
				release, fetchErr := FetchVerifiedRelease(
					server.URL+"/channels/stable.json",
					base64.StdEncoding.EncodeToString(publicKey),
					"linux",
					"amd64",
				)
				if fetchErr != nil {
					errorsSeen <- fetchErr
					continue
				}
				version := release.Manifest.Version
				if (version != "1.0.0" && version != "2.0.0") ||
					!strings.Contains(release.URL, "/releases/"+version+"/") {
					errorsSeen <- fmt.Errorf("mixed release observed: %+v", release)
				}
			}
		}()
	}
	for index := range 200 {
		if index%2 == 0 {
			activeChannel.Store(newChannel)
		} else {
			activeChannel.Store(oldChannel)
		}
	}
	activeChannel.Store(newChannel)
	readersDone.Wait()
	close(errorsSeen)
	for observed := range errorsSeen {
		t.Error(observed)
	}
}

func TestReplaceExecutableHealthCheckRollback(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "path with spaces")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dir, "agent")
	newFile := filepath.Join(dir, "agent-new")
	if err := os.WriteFile(target, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(newFile, []byte("new"), 0o755); err != nil {
		t.Fatal(err)
	}
	err := replaceExecutableWithHealthCheck(
		newFile,
		target,
		"v2.0.0",
		func(string) (string, error) { return "", errors.New("startup failed") },
	)
	if err == nil {
		t.Fatal("health check failure must trigger rollback")
	}
	contents, readErr := os.ReadFile(target)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(contents) != "old" {
		t.Fatalf("rollback restored %q, want old", contents)
	}
}
