package selfmgmt

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
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

func TestDownloadURL(t *testing.T) {
	cases := []struct {
		base, goos, goarch, want string
	}{
		{"https://dl.xugou.mdzz.uk/latest", "linux", "amd64", "https://dl.xugou.mdzz.uk/latest/xugou-agent-linux-amd64"},
		{"https://dl.xugou.mdzz.uk/latest/", "darwin", "arm64", "https://dl.xugou.mdzz.uk/latest/xugou-agent-darwin-arm64"},
		{"http://example.com/dist//", "windows", "arm64", "http://example.com/dist/xugou-agent-windows-arm64.exe"},
	}
	for _, c := range cases {
		if got := DownloadURL(c.base, c.goos, c.goarch); got != c.want {
			t.Errorf("DownloadURL(%q, %q, %q) = %q, want %q", c.base, c.goos, c.goarch, got, c.want)
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
		{"2.0", "2.0.0", 0, true},
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

func TestReplaceExecutable(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "agent")
	newFile := filepath.Join(dir, "agent-new")

	if err := os.WriteFile(target, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(newFile, []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := ReplaceExecutable(newFile, target); err != nil {
		t.Fatalf("ReplaceExecutable failed: %v", err)
	}

	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "new" {
		t.Errorf("target content = %q, want %q", data, "new")
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Errorf("target is not executable: %v", info.Mode())
	}
	if _, err := os.Stat(target + ".old"); !os.IsNotExist(err) {
		t.Errorf("backup file should be removed, stat err = %v", err)
	}
	if _, err := os.Stat(newFile); !os.IsNotExist(err) {
		t.Errorf("new file should be renamed away, stat err = %v", err)
	}
}

func TestReplaceExecutableMissingTarget(t *testing.T) {
	dir := t.TempDir()
	newFile := filepath.Join(dir, "agent-new")
	if err := os.WriteFile(newFile, []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ReplaceExecutable(newFile, filepath.Join(dir, "missing-target")); err == nil {
		t.Error("expected error when target does not exist")
	}
}

func TestDownloadToFile(t *testing.T) {
	payload := append([]byte{0x7f, 'E', 'L', 'F'}, []byte("fake binary body")...)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/missing" {
			http.NotFound(w, r)
			return
		}
		w.Write(payload)
	}))
	defer srv.Close()

	dir := t.TempDir()
	path, err := DownloadToFile(srv.URL+"/xugou-agent-linux-amd64", dir)
	if err != nil {
		t.Fatalf("DownloadToFile failed: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != string(payload) {
		t.Errorf("downloaded content mismatch")
	}

	if _, err := DownloadToFile(srv.URL+"/missing", dir); err == nil {
		t.Error("expected error for 404 response")
	}
}
