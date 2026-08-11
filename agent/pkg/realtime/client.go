// Package realtime 提供 Agent 到 Worker 的独立上行 WebSocket。
//
// WebSocket 只传递最新实时样本；断线期间不在内存堆积历史帧。完整样本仍由
// 调用方先写入本地 spool，并按固定周期通过 HTTP 批量投递。
package realtime

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/xugou/agent/pkg/config"
	"github.com/xugou/agent/pkg/model"
)

const (
	liveProtocolVersion = 1
	reconnectMinDelay   = time.Second
	reconnectMaxDelay   = 30 * time.Second
	pingInterval        = 25 * time.Second
	writeTimeout        = 5 * time.Second
	readLimitBytes      = 64 * 1024
)

// Client 维护单条可自动重连的上行连接。Publish 始终为非阻塞调用。
type Client struct {
	serverURL    string
	token        string
	agentVersion string
	dialer       websocket.Dialer

	mu             sync.Mutex
	latest         chan *model.LiveMetricFrame
	sequence       uint64
	previousAt     time.Time
	previousRx     uint64
	previousTx     uint64
	hasPreviousNet bool
}

// NewClient 根据 Agent 的 HTTP Server URL 构造对应的 ws/wss 上行客户端。
func NewClient(serverURL, token, agentVersion, proxyURL string) (*Client, error) {
	if _, err := buildWebSocketURL(serverURL); err != nil {
		return nil, err
	}
	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
		Proxy:            http.ProxyFromEnvironment,
	}
	if strings.TrimSpace(proxyURL) != "" {
		proxy, err := url.Parse(proxyURL)
		if err != nil {
			return nil, fmt.Errorf("解析 WebSocket 代理 URL 失败: %w", err)
		}
		dialer.Proxy = http.ProxyURL(proxy)
	}
	return &Client{
		serverURL:    serverURL,
		token:        token,
		agentVersion: agentVersion,
		dialer:       dialer,
		latest:       make(chan *model.LiveMetricFrame, 1),
	}, nil
}

func buildWebSocketURL(serverURL string) (string, error) {
	base, err := url.Parse(strings.TrimSpace(serverURL))
	if err != nil || base.Host == "" {
		return "", fmt.Errorf("实时服务器 URL 非法: %q", serverURL)
	}
	switch strings.ToLower(base.Scheme) {
	case "http":
		base.Scheme = "ws"
	case "https":
		base.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("实时服务器 URL 协议非法: %q", base.Scheme)
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/api/v2/agents/live"
	base.RawPath = ""
	base.RawQuery = ""
	base.Fragment = ""
	return base.String(), nil
}

// Publish 生成一条实时帧并用最新值覆盖尚未发出的旧帧。网络状态不会阻塞采集。
func (c *Client) Publish(info *model.SystemInfo) {
	if info == nil {
		return
	}
	c.mu.Lock()
	c.sequence++
	rx, tx, hasNetwork := sumNetworkTotals(info.Network)
	var rxSpeed, txSpeed *float64
	if hasNetwork && c.hasPreviousNet && info.Timestamp.After(c.previousAt) {
		seconds := info.Timestamp.Sub(c.previousAt).Seconds()
		if rx >= c.previousRx {
			value := float64(rx-c.previousRx) / seconds
			rxSpeed = &value
		}
		if tx >= c.previousTx {
			value := float64(tx-c.previousTx) / seconds
			txSpeed = &value
		}
	}
	if hasNetwork {
		c.previousAt = info.Timestamp
		c.previousRx = rx
		c.previousTx = tx
		c.hasPreviousNet = true
	}
	frame := &model.LiveMetricFrame{
		Type:            "metric",
		ProtocolVersion: liveProtocolVersion,
		Sequence:        c.sequence,
		CollectedAt:     info.Timestamp.UTC().Format(time.RFC3339Nano),
		CPU:             info.CPU,
		Memory:          info.Memory,
		Load:            info.Load,
		Network:         append([]model.NetworkInfo(nil), info.Network...),
		Swap:            info.Swap,
		NetworkRxSpeed:  rxSpeed,
		NetworkTxSpeed:  txSpeed,
	}

	select {
	case c.latest <- frame:
	default:
		select {
		case <-c.latest:
		default:
		}
		c.latest <- frame
	}
	c.mu.Unlock()
}

func sumNetworkTotals(network []model.NetworkInfo) (uint64, uint64, bool) {
	var rx, tx uint64
	hasNetwork := false
	for _, item := range network {
		if isLoopbackInterface(item.Interface) {
			continue
		}
		rx += item.BytesRecv
		tx += item.BytesSent
		hasNetwork = true
	}
	return rx, tx, hasNetwork
}

func isLoopbackInterface(name string) bool {
	value := strings.ToLower(strings.TrimSpace(name))
	if strings.Contains(value, "loopback") {
		return true
	}
	if value == "lo" {
		return true
	}
	if !strings.HasPrefix(value, "lo") || len(value) == 2 {
		return false
	}
	for _, char := range value[2:] {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

// Run 维护连接直到 ctx 结束。鉴权失败、网络抖动和 Worker 重启都会进入有上限的
// 指数退避；spool 与 HTTP 上报由独立主循环继续执行。
func (c *Client) Run(ctx context.Context) {
	delay := reconnectMinDelay
	for ctx.Err() == nil {
		conn, err := c.connect(ctx)
		if err == nil {
			log.Printf("实时 WebSocket 已连接")
			delay = reconnectMinDelay
			err = c.stream(ctx, conn)
		}
		if ctx.Err() != nil {
			return
		}
		log.Printf("实时 WebSocket 已断开，将自动重连: %v", err)
		jitter := time.Duration(rand.Int64N(max(int64(delay/4), 1)))
		timer := time.NewTimer(delay + jitter)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return
		case <-timer.C:
		}
		delay = min(delay*2, reconnectMaxDelay)
	}
}

func (c *Client) connect(ctx context.Context) (*websocket.Conn, error) {
	endpoint, err := buildWebSocketURL(c.serverURL)
	if err != nil {
		return nil, err
	}
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+c.token)
	headers.Set(config.HeaderAgentVersion, c.agentVersion)
	conn, response, err := c.dialer.DialContext(ctx, endpoint, headers)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		if response != nil {
			return nil, fmt.Errorf("WebSocket 握手返回 HTTP %d: %w", response.StatusCode, err)
		}
		return nil, err
	}
	conn.SetReadLimit(readLimitBytes)
	return conn, nil
}

func (c *Client) stream(ctx context.Context, conn *websocket.Conn) error {
	defer conn.Close()
	readErr := make(chan error, 1)
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				readErr <- err
				return
			}
		}
	}()

	pingTicker := time.NewTicker(pingInterval)
	defer pingTicker.Stop()
	for {
		select {
		case <-ctx.Done():
			deadline := time.Now().Add(writeTimeout)
			_ = conn.WriteControl(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, "shutdown"),
				deadline,
			)
			return ctx.Err()
		case err := <-readErr:
			return err
		case frame := <-c.latest:
			if err := writeFrame(conn, frame); err != nil {
				c.requeue(frame)
				return err
			}
		case <-pingTicker.C:
			if err := conn.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
				return err
			}
			if err := conn.WriteMessage(websocket.TextMessage, []byte("ping")); err != nil {
				return err
			}
		}
	}
}

func writeFrame(conn *websocket.Conn, frame *model.LiveMetricFrame) error {
	payload, err := json.Marshal(frame)
	if err != nil {
		return fmt.Errorf("序列化实时指标失败: %w", err)
	}
	if len(payload) > readLimitBytes {
		return fmt.Errorf("实时指标帧超过 %d 字节", readLimitBytes)
	}
	if err := conn.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
		return err
	}
	if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
		return fmt.Errorf("发送实时指标失败: %w", err)
	}
	return nil
}

func (c *Client) requeue(frame *model.LiveMetricFrame) {
	if frame == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	select {
	case existing := <-c.latest:
		if existing.Sequence > frame.Sequence {
			frame = existing
		}
	default:
	}
	c.latest <- frame
}
