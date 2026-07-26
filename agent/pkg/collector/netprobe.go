package collector

import (
	"context"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/spf13/viper"
	"github.com/xugou/agent/pkg/model"
)

const (
	// probeInterval 拨测独立周期：结果缓存 30 秒，采集频率再高也不会放大拨测开销
	probeInterval = 30 * time.Second
	// probeTimeout 单次 TCP 拨测超时，超时视为丢包
	probeTimeout = 3 * time.Second
	// defaultProbePort 未指定端口时的默认端口
	defaultProbePort = "443"
)

// 四线路默认拨测目标（TCP 443，代替 ICMP 避免 raw socket 权限问题）。
// 常量表已含端口，无需再走 normalizeProbeTarget。
var defaultPingTargets = map[string]string{
	"ct": "www.189.cn:443",    // 电信
	"cu": "www.10010.com:443", // 联通
	"cm": "www.10086.cn:443",  // 移动
	"bd": "www.baidu.com:443", // 百度
}

// IPv4/IPv6 可达性固定拨测目标（Cloudflare 1.1.1.1）
const (
	ipv4ProbeAddr = "1.1.1.1:443"
	ipv6ProbeAddr = "[2606:4700:4700::1111]:443"
)

type probeSnapshot struct {
	ping          map[string]model.PingResult
	ipv4Reachable bool
	ipv6Reachable bool
	collectedAt   time.Time
}

type netProber struct {
	mu         sync.Mutex
	snapshot   *probeSnapshot
	refreshing bool // 后台刷新进行中，防止并发重复拨测
}

// normalizeProbeTarget 规范化拨测目标：支持 host 或 host:port，未指定端口时补默认端口。
// 非法输入返回空串。纯函数，便于单测。
func normalizeProbeTarget(value string, defaultPort string) string {
	raw := strings.TrimSpace(value)
	if raw == "" {
		return ""
	}
	if len(raw) > 128 || strings.Contains(raw, "://") ||
		strings.ContainsAny(raw, " \t\r\n/@?#\\[]") {
		return ""
	}

	host := raw
	port := defaultPort
	if idx := strings.LastIndex(raw, ":"); idx >= 0 {
		// 含多个冒号（裸 IPv6 字面量等）不支持，避免歧义
		if strings.Count(raw, ":") > 1 {
			return ""
		}
		host = raw[:idx]
		port = raw[idx+1:]
	}
	if host == "" || port == "" {
		return ""
	}
	portNum, err := strconv.Atoi(port)
	if err != nil || portNum < 1 || portNum > 65535 {
		return ""
	}
	return host + ":" + strconv.Itoa(portNum)
}

// resolvePingTargets 合并默认目标与 viper 配置（键 ping_ct/ping_cu/ping_cm/ping_bd）。
// 只有用户配置的目标需要规范化，默认目标本身已是合法的 host:port。
func resolvePingTargets() map[string]string {
	targets := make(map[string]string, len(defaultPingTargets))
	for line, target := range defaultPingTargets {
		if custom := normalizeProbeTarget(viper.GetString("ping_"+line), defaultProbePort); custom != "" {
			target = custom
		}
		targets[line] = target
	}
	return targets
}

// probeTCP 对目标做一次 TCP 连接测延迟；失败/超时视为丢包
func probeTCP(ctx context.Context, network, addr string) (float64, bool) {
	dialer := &net.Dialer{Timeout: probeTimeout}
	start := time.Now()
	conn, err := dialer.DialContext(ctx, network, addr)
	if err != nil {
		return -1, false
	}
	latency := float64(time.Since(start).Microseconds()) / 1000.0
	_ = conn.Close()
	return latency, true
}

// refresh 并行执行全部拨测（四线路 + IPv4/IPv6 可达性），总耗时不超过 probeTimeout
func (p *netProber) refresh(ctx context.Context) *probeSnapshot {
	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout+time.Second)
	defer cancel()

	targets := resolvePingTargets()
	snapshot := &probeSnapshot{
		ping:        make(map[string]model.PingResult, len(targets)),
		collectedAt: time.Now(),
	}

	var wg sync.WaitGroup
	var mu sync.Mutex

	for line, target := range targets {
		wg.Add(1)
		go func(line, target string) {
			defer wg.Done()
			latency, ok := probeTCP(probeCtx, "tcp", target)
			mu.Lock()
			snapshot.ping[line] = model.PingResult{
				Target:    target,
				LatencyMs: latency,
				Loss:      !ok,
			}
			mu.Unlock()
		}(line, target)
	}

	wg.Add(2)
	go func() {
		defer wg.Done()
		_, ok := probeTCP(probeCtx, "tcp4", ipv4ProbeAddr)
		mu.Lock()
		snapshot.ipv4Reachable = ok
		mu.Unlock()
	}()
	go func() {
		defer wg.Done()
		_, ok := probeTCP(probeCtx, "tcp6", ipv6ProbeAddr)
		mu.Lock()
		snapshot.ipv6Reachable = ok
		mu.Unlock()
	}()

	wg.Wait()
	return snapshot
}

// current 返回缓存的拨测结果，永不返回 nil。
// stale-while-revalidate：缓存过期时立即返回旧快照，并起后台 goroutine 刷新
// （refreshing 标志防并发），避免最长 ~4s 的网络拨测阻塞采集路径；
// 仅首次无快照时同步刷新一次。
func (p *netProber) current(ctx context.Context) *probeSnapshot {
	p.mu.Lock()

	if p.snapshot == nil {
		// 首次调用：同步刷新，保证调用方总能拿到有效快照
		p.mu.Unlock()
		snapshot := p.refresh(ctx)
		p.mu.Lock()
		if p.snapshot == nil {
			p.snapshot = snapshot
		}
		snapshot = p.snapshot
		p.mu.Unlock()
		return snapshot
	}

	snapshot := p.snapshot
	if time.Since(snapshot.collectedAt) >= probeInterval && !p.refreshing {
		p.refreshing = true
		// refresh 自带 probeTimeout+1s 的超时，用 Background 避免采集轮
		// 上下文取消而中断后台刷新
		go func() {
			fresh := p.refresh(context.Background())
			p.mu.Lock()
			p.snapshot = fresh
			p.refreshing = false
			p.mu.Unlock()
		}()
	}
	p.mu.Unlock()
	return snapshot
}
