package reporter

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/xugou/agent/pkg/config"
	"github.com/xugou/agent/pkg/model"
	"github.com/xugou/agent/pkg/utils"
)

// setDefaultHeaders 设置所有请求的通用头部
func setDefaultHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36")
	req.Header.Set("Referer", "https://www.google.com/")
}

// setConfigHeaders 上报请求附带配置协议头：协议版本 + 本地配置规范化串的 MD5 + 探针版本
func setConfigHeaders(req *http.Request) {
	req.Header.Set(config.HeaderConfigSchema, strconv.Itoa(config.SchemaVersion))
	req.Header.Set(config.HeaderConfigMd5, config.CurrentConfigMD5())
	if config.AgentVersion != "" {
		req.Header.Set(config.HeaderAgentVersion, config.AgentVersion)
	}
}

// Reporter 定义数据上报器接口
type Reporter interface {
	// ReportBatch 上报批量采集的系统信息；服务端下发新配置时返回非 nil 的 RemoteConfig
	ReportBatch(ctx context.Context, infoList []*model.SystemInfo) (*config.RemoteConfig, error)
}

type DefaultReporter struct {
	reporter *model.HTTPReporter
}

func NewReporter() Reporter {
	return &DefaultReporter{
		reporter: NewHTTPReporter(),
	}
}

// NewHTTPReporter 创建一个新的HTTP数据上报器
func NewHTTPReporter() *model.HTTPReporter {
	// 创建HTTP客户端
	client := &http.Client{
		Timeout: 10 * time.Second,
	}

	// 如果设置了代理，配置代理
	if config.ProxyURL != "" {
		proxy, err := url.Parse(config.ProxyURL)
		if err != nil {
			fmt.Printf("警告: 代理URL解析失败: %v，将不使用代理\n", err)
		} else {
			client.Transport = &http.Transport{
				Proxy: http.ProxyURL(proxy),
			}
		}
	}

	reporter := &model.HTTPReporter{
		ServerURL:  utils.NormalizeURL(config.ServerURL),
		ApiToken:   config.Token,
		ProxyURL:   config.ProxyURL,
		Client:     client,
		Registered: false,
	}

	return reporter
}

// ReportBatch 将多个系统信息批量上报到服务器。
// 上报体为 {<最新样本的全部字段>, samples: [...]}：顶层保持旧协议形态（旧服务端忽略未知的
// samples 字段），samples 承载整个窗口内的全部采集样本。
// 服务端通过 204/200+form 串下发配置：有新配置且校验通过时返回非 nil 的 RemoteConfig。
func (r *DefaultReporter) ReportBatch(ctx context.Context, infoList []*model.SystemInfo) (*config.RemoteConfig, error) {
	if len(infoList) == 0 {
		return nil, errors.New("没有可上报的系统信息")
	}

	if !r.reporter.Registered {
		// 客户端未注册，先注册
		if err := r.register(ctx, infoList[0]); err != nil {
			log.Printf("注册客户端失败: %v", err)
			return nil, err
		}
	}

	samples := make([]*model.Sample, 0, len(infoList))
	for _, info := range infoList {
		samples = append(samples, model.NewSample(info))
	}

	payload := &model.StatusReport{
		SystemInfo: infoList[len(infoList)-1],
		Samples:    samples,
	}

	reportURL := fmt.Sprintf("%s/api/agents/status", r.reporter.ServerURL)
	reportPaylod, err := json.Marshal(payload)

	if err != nil {
		log.Println("序列化上报数据失败: ", err)
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, "POST", reportURL, bytes.NewBuffer(reportPaylod))
	if err != nil {
		log.Println("创建请求失败：", err)
		return nil, err
	}
	setDefaultHeaders(req)
	setConfigHeaders(req)

	resp, err := r.reporter.Client.Do(req)
	if err != nil {
		log.Println("上报数据失败：", err)
		return nil, err
	}
	defer resp.Body.Close()
	if err := checkResponse(resp, "上报数据失败"); err != nil {
		log.Println(err)
		return nil, err
	}
	log.Printf("批量上报数据成功: count=%d", len(infoList))
	return parseConfigResponse(resp), nil
}

// parseConfigResponse 解析上报响应中的配置下发：
// 204 表示配置无变化；200 + application/x-www-form-urlencoded 为新配置串，
// 整体校验失败时丢弃并继续使用旧配置（下次上报会重新获取）；其余响应（旧协议 JSON）忽略。
func parseConfigResponse(resp *http.Response) *config.RemoteConfig {
	if resp.StatusCode == http.StatusNoContent {
		return nil
	}
	contentType := resp.Header.Get("Content-Type")
	if resp.StatusCode != http.StatusOK ||
		!strings.HasPrefix(contentType, "application/x-www-form-urlencoded") {
		return nil
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1024))
	if err != nil {
		log.Println("读取配置下发响应失败: ", err)
		return nil
	}

	remote, err := config.ParseRemoteConfig(strings.TrimSpace(string(body)))
	if err != nil {
		log.Println("服务端下发配置校验失败，已整体丢弃: ", err)
		return nil
	}
	return remote
}

func (r *DefaultReporter) register(ctx context.Context, info *model.SystemInfo) error {

	log.Println("开始检查是否客户端已经注册，未注册将会自动注册")

	registerURL := fmt.Sprintf("%s/api/agents/register", r.reporter.ServerURL)
	registerPaylod := &model.RegisterPayload{
		Token:       config.Token,
		Name:        info.Hostname,
		Hostname:    info.Hostname,
		IPAddresses: utils.GetLocalIPs(),
		OS:          info.OS,
		Version:     info.Version,
	}

	data, err := json.Marshal(registerPaylod)

	if err != nil {
		log.Println("注册客户端失败: ", err)
		return err
	}

	req, err := http.NewRequestWithContext(ctx, "POST", registerURL, bytes.NewBuffer(data))
	if err != nil {
		log.Println("创建请求失败: ", err)
		return err
	}
	setDefaultHeaders(req)

	resp, err := r.reporter.Client.Do(req)
	if err != nil {
		log.Println("注册客户端失败: ", err)
		return err
	}
	defer resp.Body.Close()
	if err := checkResponse(resp, "注册客户端失败"); err != nil {
		log.Println(err)
		return err
	}

	body, err := io.ReadAll(resp.Body)

	if err != nil {
		log.Println("注册客户端失败: ", err)
		return err
	}

	var respData *model.RegisterResponse

	if err := json.Unmarshal(body, &respData); err != nil {
		log.Println("注册客户端失败: ", err)
		return err
	}

	if !respData.Success {
		log.Println("注册客户端失败: ", respData.Message)
		return errors.New(respData.Message)
	}

	log.Printf("客户端 ID: %d", respData.Agent.ID)

	r.reporter.Registered = true

	return nil
}

func checkResponse(resp *http.Response, message string) error {
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	if len(body) == 0 {
		return fmt.Errorf("%s: HTTP %d", message, resp.StatusCode)
	}
	return fmt.Errorf("%s: HTTP %d: %s", message, resp.StatusCode, string(body))
}
