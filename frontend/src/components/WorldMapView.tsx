import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { MetricHistory } from "../types/agents";
import type { DashboardAgent } from "../api/dashboard";
import {
  COUNTRY_CENTROIDS,
  COUNTRY_PATHS,
  WORLD_VIEWBOX,
  projectPoint,
} from "../assets/worldMap";
import { memoryPercent, mergeLatestMetric } from "../utils/metrics";
import { regionFlagEmoji, regionLabel } from "../utils/region";

/**
 * 城市级散点世界地图视图（Dashboard 第 4 视图）
 * - 底图：构建期预投影的国家轮廓（assets/worldMap.ts，运行时零依赖）
 * - 散点：有 geo 经纬度 → 实心点；仅有 region → 国家质心空心虚线点；
 *   两者皆无 → 角落「未知位置 n」徽章；同城（geo_city+国家码）聚合
 * - 交互：hover 终端风格 tooltip；单机点击跳详情，多机点击联动地区筛选；
 *   wheel 缩放（指针为中心，1x-8x）+ 拖拽平移 + 双击复位 + 右下角按钮
 */

interface WorldMapViewProps {
  agents: DashboardAgent[];
  liveMetrics: Record<number, Partial<MetricHistory>>;
  onSelectRegion: (regionCode: string) => void;
  /** 单机点点击行为覆盖（公开状态页展开详情）；缺省时跳转 /agents/:id */
  onSelectAgent?: (agentId: number) => void;
}

interface MapCluster {
  key: string;
  x: number;
  y: number;
  // geo=精确坐标实心点；centroid=国家质心降级空心点
  kind: "geo" | "centroid";
  city: string | null;
  regionName: string | null;
  countryCode: string | null;
  agents: DashboardAgent[];
}

const W = WORLD_VIEWBOX;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.4;
// tooltip 内逐 agent 列表上限（超出显示 +n）
const TOOLTIP_MAX_AGENTS = 8;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const hasGeoCoords = (agent: DashboardAgent) =>
  isFiniteNumber(agent.geo_latitude) &&
  isFiniteNumber(agent.geo_longitude) &&
  Math.abs(agent.geo_latitude) <= 90 &&
  Math.abs(agent.geo_longitude) <= 180;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const WorldMapView = ({
  agents,
  liveMetrics,
  onSelectRegion,
  onSelectAgent,
}: WorldMapViewProps) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // viewBox 状态（缩放平移的唯一事实源）；ref 镜像供原生 wheel 回调读取
  const [vb, setVb] = useState<{ x: number; y: number; w: number; h: number }>({
    x: W.x,
    y: W.y,
    w: W.width,
    h: W.height,
  });
  const vbRef = useRef(vb);
  vbRef.current = vb;
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    vbX: number;
    vbY: number;
    moved: boolean;
  } | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  // ---- 散点聚合（geo：同城 geo_city+国家码；质心：按国家） ----
  const { clusters, unknownCount, countriesWithNodes } = useMemo(() => {
    const map = new Map<string, MapCluster>();
    const withNodes = new Set<string>();
    let unknown = 0;
    for (const agent of agents) {
      const country = regionLabel(agent.region);
      if (hasGeoCoords(agent)) {
        const lat = agent.geo_latitude as number;
        const lon = agent.geo_longitude as number;
        const city = agent.geo_city?.trim() || null;
        const key = `geo|${country ?? ""}|${
          city ?? `${lat.toFixed(2)},${lon.toFixed(2)}`
        }`;
        let cluster = map.get(key);
        if (!cluster) {
          const [x, y] = projectPoint(lat, lon);
          cluster = {
            key,
            x,
            y,
            kind: "geo",
            city,
            regionName: agent.geo_region_name?.trim() || null,
            countryCode: country,
            agents: [],
          };
          map.set(key, cluster);
        }
        cluster.agents.push(agent);
        if (country) withNodes.add(country);
        continue;
      }
      const centroid = country ? COUNTRY_CENTROIDS[country] : undefined;
      if (country && centroid) {
        const key = `centroid|${country}`;
        let cluster = map.get(key);
        if (!cluster) {
          cluster = {
            key,
            x: centroid[0],
            y: centroid[1],
            kind: "centroid",
            city: null,
            regionName: null,
            countryCode: country,
            agents: [],
          };
          map.set(key, cluster);
        }
        cluster.agents.push(agent);
        withNodes.add(country);
        continue;
      }
      unknown += 1;
    }
    return {
      clusters: [...map.values()],
      unknownCount: unknown,
      countriesWithNodes: withNodes,
    };
  }, [agents]);

  const hoverCluster = hoverKey
    ? clusters.find((cluster) => cluster.key === hoverKey) ?? null
    : null;

  // ---- 缩放平移 ----
  const applyZoom = useCallback((factor: number, cx?: number, cy?: number) => {
    setVb((prev) => {
      const newW = clamp(prev.w / factor, W.width / MAX_ZOOM, W.width);
      if (newW === prev.w) return prev;
      const newH = newW * (W.height / W.width);
      // 缺省以当前视口中心为缩放锚点
      const anchorX = cx ?? prev.x + prev.w / 2;
      const anchorY = cy ?? prev.y + prev.h / 2;
      const ratioX = (anchorX - prev.x) / prev.w;
      const ratioY = (anchorY - prev.y) / prev.h;
      return {
        x: clamp(anchorX - ratioX * newW, W.x, W.x + W.width - newW),
        y: clamp(anchorY - ratioY * newH, W.y, W.y + W.height - newH),
        w: newW,
        h: newH,
      };
    });
  }, []);

  const resetView = useCallback(() => {
    setVb({ x: W.x, y: W.y, w: W.width, h: W.height });
  }, []);

  // wheel 缩放需 preventDefault（阻止页面滚动），必须以 passive:false 原生绑定
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const prev = vbRef.current;
      const px = prev.x + ((event.clientX - rect.left) / rect.width) * prev.w;
      const py = prev.y + ((event.clientY - rect.top) / rect.height) * prev.h;
      applyZoom(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, px, py);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [applyZoom]);

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    // 此处不能立刻 setPointerCapture：捕获会把手势派生的 click 重定向到
    // svg 本身，散点的 onClick 将永远收不到。首次超过阈值的移动才捕获。
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      vbX: vbRef.current.x,
      vbY: vbRef.current.y,
      moved: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    const svg = svgRef.current;
    if (!drag || !svg || drag.pointerId !== event.pointerId) return;
    if (
      !drag.moved &&
      Math.abs(event.clientX - drag.startX) <= 3 &&
      Math.abs(event.clientY - drag.startY) <= 3
    ) {
      return; // 未超过拖拽阈值，保持 click 语义
    }
    if (!drag.moved) {
      drag.moved = true;
      setDragging(true);
      try {
        svg.setPointerCapture(drag.pointerId);
      } catch {
        // 部分环境（如合成事件回放）不支持捕获，拖拽仍可工作
      }
    }
    const rect = svg.getBoundingClientRect();
    const dx = ((event.clientX - drag.startX) / rect.width) * vbRef.current.w;
    const dy = ((event.clientY - drag.startY) / rect.height) * vbRef.current.h;
    setVb((prev) => ({
      ...prev,
      x: clamp(drag.vbX - dx, W.x, W.x + W.width - prev.w),
      y: clamp(drag.vbY - dy, W.y, W.y + W.height - prev.h),
    }));
  };

  const endDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const svg = svgRef.current;
    if (svg?.hasPointerCapture(event.pointerId)) {
      svg.releasePointerCapture(event.pointerId);
    }
    // 微任务后清除，让同一手势派生的 click 能读到 moved 标记
    setTimeout(() => {
      dragRef.current = null;
    }, 0);
    setDragging(false);
  };

  const onClusterClick = (cluster: MapCluster) => {
    if (dragRef.current?.moved) return; // 拖拽结束派生的 click 不触发
    if (cluster.agents.length === 1) {
      if (onSelectAgent) {
        onSelectAgent(cluster.agents[0].id);
      } else {
        navigate(`/agents/${cluster.agents[0].id}`);
      }
      return;
    }
    if (cluster.countryCode) {
      onSelectRegion(cluster.countryCode);
    }
  };

  // 世界坐标 → 容器百分比（tooltip 定位；纯 CSS %，无需量测容器）
  const toPercent = (x: number, y: number) => ({
    left: ((x - vb.x) / vb.w) * 100,
    top: ((y - vb.y) / vb.h) * 100,
  });

  // 缩放时散点/文字在屏幕上保持恒定大小：世界单位尺寸随 viewBox 收缩
  const s = vb.w / W.width;
  const zoomLevel = W.width / vb.w;

  const agentStatusText: Record<string, string> = {
    active: t("agent.status.online"),
    connecting: t("agent.status.connecting"),
    inactive: t("agent.status.offline"),
  };

  const renderTooltip = (cluster: MapCluster) => {
    const pos = toPercent(cluster.x, cluster.y);
    const flag = cluster.countryCode
      ? regionFlagEmoji(cluster.countryCode)
      : null;
    const place = [cluster.city, cluster.regionName]
      .filter(Boolean)
      .join(", ");
    const translateX =
      pos.left < 15 ? "0%" : pos.left > 85 ? "-100%" : "-50%";
    const below = pos.top < 35;
    const shown = cluster.agents.slice(0, TOOLTIP_MAX_AGENTS);
    return (
      <div
        className="map-tooltip"
        style={{
          left: `${clamp(pos.left, 0, 100)}%`,
          top: `${clamp(pos.top, 0, 100)}%`,
          transform: `translate(${translateX}, ${below ? "14px" : "calc(-100% - 14px)"})`,
        }}
      >
        <div className="map-tooltip-title">
          {flag && <span>{flag} </span>}
          {place && <span>{place} </span>}
          {cluster.countryCode && (
            <span className="map-tooltip-code">[{cluster.countryCode}]</span>
          )}
          {cluster.kind === "centroid" && (
            <div className="map-tooltip-hint">
              {t("dashboard.map.approxLocation")}
            </div>
          )}
        </div>
        {shown.map((agent) => {
          const metric = mergeLatestMetric(
            agent.metrics ?? undefined,
            liveMetrics[agent.id]
          );
          const cpu = metric?.cpu_usage;
          const ram = memoryPercent(metric);
          const online = agent.status === "active";
          return (
            <div key={agent.id} className="map-tooltip-row">
              <span
                className="map-tooltip-status"
                style={{
                  color: online ? "var(--accent-green)" : "var(--accent-red)",
                }}
                title={agentStatusText[agent.status] ?? agent.status}
              >
                ●
              </span>
              <span className="map-tooltip-name">{agent.name}</span>
              <span className="map-tooltip-metrics">
                {`CPU ${isFiniteNumber(cpu) ? `${cpu.toFixed(0)}%` : "-"} · RAM ${
                  isFiniteNumber(ram) ? `${ram.toFixed(0)}%` : "-"
                }`}
              </span>
            </div>
          );
        })}
        {cluster.agents.length > shown.length && (
          <div className="map-tooltip-hint">
            +{cluster.agents.length - shown.length}
          </div>
        )}
        <div className="map-tooltip-hint">
          {cluster.agents.length === 1
            ? t("dashboard.map.detailHint")
            : t("dashboard.map.filterHint")}
        </div>
      </div>
    );
  };

  return (
    <div className="map-view" ref={containerRef}>
      <svg
        ref={svgRef}
        className={`map-svg${dragging ? " dragging" : ""}`}
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        role="img"
        aria-label={t("dashboard.view.map")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={resetView}
      >
        {/* 底图国家轮廓（有节点的国家提亮） */}
        <g style={{ strokeWidth: 0.5 * s }}>
          {COUNTRY_PATHS.map(({ iso2, path }) => (
            <path
              key={iso2}
              d={path}
              className={`map-country${
                countriesWithNodes.has(iso2) ? " has-nodes" : ""
              }`}
            />
          ))}
        </g>
        {/* 散点（同城聚合；hover 的点最后渲染避免被邻点盖住） */}
        <g>
          {[...clusters]
            .sort((a, b) =>
              a.key === hoverKey ? 1 : b.key === hoverKey ? -1 : a.y - b.y
            )
            .map((cluster) => {
              const count = cluster.agents.length;
              const hasOffline = cluster.agents.some(
                (agent) => agent.status !== "active"
              );
              const color = hasOffline
                ? "var(--accent-red)"
                : "var(--accent-green)";
              const r = (count > 1 ? 7 : 5) * s;
              return (
                <g
                  key={cluster.key}
                  className="map-cluster"
                  onClick={() => onClusterClick(cluster)}
                  onPointerEnter={() => setHoverKey(cluster.key)}
                  onPointerLeave={() =>
                    setHoverKey((key) => (key === cluster.key ? null : key))
                  }
                >
                  {/* 在线点呼吸光环（respects prefers-reduced-motion） */}
                  {!hasOffline && (
                    <circle
                      className="map-dot-halo"
                      cx={cluster.x}
                      cy={cluster.y}
                      r={r}
                      style={{ stroke: color, strokeWidth: 1.2 * s }}
                    />
                  )}
                  <circle
                    cx={cluster.x}
                    cy={cluster.y}
                    r={r}
                    fill={cluster.kind === "geo" ? color : "var(--bg-primary)"}
                    stroke={cluster.kind === "geo" ? "var(--bg-primary)" : color}
                    strokeWidth={(cluster.kind === "geo" ? 1 : 1.4) * s}
                    strokeDasharray={
                      cluster.kind === "centroid" ? `${2.2 * s} ${2 * s}` : undefined
                    }
                  />
                  {count > 1 && (
                    <text
                      className="map-dot-count"
                      x={cluster.x}
                      y={cluster.y}
                      textAnchor="middle"
                      dy="0.35em"
                      style={{
                        fontSize: 8 * s,
                        fill:
                          cluster.kind === "geo"
                            ? "var(--bg-primary)"
                            : "var(--text-primary)",
                      }}
                    >
                      {count}
                    </text>
                  )}
                </g>
              );
            })}
        </g>
      </svg>

      {/* hover tooltip（terminal-card 风格浮层） */}
      {hoverCluster && !dragging && renderTooltip(hoverCluster)}

      {/* 未知位置徽章（geo 与 region 均缺失的 agent 计数） */}
      {unknownCount > 0 && (
        <div className="map-unknown-badge">
          [{t("dashboard.map.unknownLocation")} {unknownCount}]
        </div>
      )}

      {/* 缩放控制（右下角，终端风格） */}
      <div className="map-zoom-controls">
        <button
          type="button"
          className="map-zoom-btn"
          onClick={() => applyZoom(ZOOM_STEP)}
          disabled={zoomLevel >= MAX_ZOOM - 1e-6}
          title={t("dashboard.map.zoomIn")}
          aria-label={t("dashboard.map.zoomIn")}
        >
          +
        </button>
        <button
          type="button"
          className="map-zoom-btn"
          onClick={() => applyZoom(1 / ZOOM_STEP)}
          disabled={zoomLevel <= 1 + 1e-6}
          title={t("dashboard.map.zoomOut")}
          aria-label={t("dashboard.map.zoomOut")}
        >
          −
        </button>
        <button
          type="button"
          className="map-zoom-btn"
          onClick={resetView}
          title={t("dashboard.map.reset")}
          aria-label={t("dashboard.map.reset")}
        >
          ⌂
        </button>
      </div>
    </div>
  );
};

export default WorldMapView;
