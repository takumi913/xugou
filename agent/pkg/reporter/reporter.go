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

// Reporter 定义数据上报器接口
type Reporter interface {
	Report(ctx context.Context, info *model.SystemInfo) error            // 上报单个采集的系统信息
	ReportBatch(ctx context.Context, infoList []*model.SystemInfo) error // 上报批量采集的系统信息
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

func (r *DefaultReporter) Report(ctx context.Context, info *model.SystemInfo) error {
	if !r.reporter.Registered {
		// 客户端未注册，先注册
		if err := r.register(ctx, info); err != nil {
			log.Printf("注册客户端失败: %v", err)
			return err
		}
	}
	reportURL := fmt.Sprintf("%s/api/agents/status", r.reporter.ServerURL)
	reportPaylod, err := json.Marshal(info)

	if err != nil {
		log.Println("注册客户端失败: ", err)
		return err
	}

	req, err := http.NewRequestWithContext(ctx, "POST", reportURL, bytes.NewBuffer(reportPaylod))
	if err != nil {
		log.Println("创建请求失败：", err)
		return err
	}
	setDefaultHeaders(req)

	resp, err := r.reporter.Client.Do(req)
	if err != nil {
		log.Println("上报数据失败：", err)
		return err
	}
	defer resp.Body.Close()
	if err := checkResponse(resp, "上报数据失败"); err != nil {
		log.Println(err)
		return err
	}
	log.Printf("上报数据成功: hostname=%s timestamp=%s", info.Hostname, info.Timestamp.Format(time.RFC3339))
	return nil
}

// ReportBatch 将多个系统信息批量上报到服务器
func (r *DefaultReporter) ReportBatch(ctx context.Context, infoList []*model.SystemInfo) error {
	if len(infoList) == 0 {
		return errors.New("没有可上报的系统信息")
	}

	if !r.reporter.Registered {
		// 客户端未注册，先注册
		if err := r.register(ctx, infoList[0]); err != nil {
			log.Printf("注册客户端失败: %v", err)
			return err
		}
	}

	reportURL := fmt.Sprintf("%s/api/agents/status", r.reporter.ServerURL)
	reportPaylod, err := json.Marshal(infoList)

	if err != nil {
		log.Println("注册客户端失败: ", err)
		return err
	}

	req, err := http.NewRequestWithContext(ctx, "POST", reportURL, bytes.NewBuffer(reportPaylod))
	if err != nil {
		log.Println("创建请求失败：", err)
		return err
	}
	setDefaultHeaders(req)

	resp, err := r.reporter.Client.Do(req)
	if err != nil {
		log.Println("上报数据失败：", err)
		return err
	}
	defer resp.Body.Close()
	if err := checkResponse(resp, "上报数据失败"); err != nil {
		log.Println(err)
		return err
	}
	log.Printf("批量上报数据成功: count=%d", len(infoList))
	return nil
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
