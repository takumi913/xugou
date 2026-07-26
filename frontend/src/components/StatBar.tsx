import { getUsageColor } from "../utils/statusColors";

/**
 * 共享细进度条（CF-SM stat-bar 风格）
 * - ProgressBar：无标签形态，仅进度条
 * - StatBar：带标签行形态，「标签 + 细进度条 + 百分比」
 *
 * clamp 语义统一：条宽按 0-100 钳制，着色用未钳制原值（与 AgentCard 现状一致）
 */
export const ProgressBar = ({ percent }: { percent: number }) => {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className="stat-bar-container">
      <div
        className="stat-bar-fill"
        style={{ width: `${clamped}%`, background: getUsageColor(percent) }}
      />
    </div>
  );
};

const StatBar = ({ label, percent }: { label: string; percent: number }) => (
  <div className="stat-row">
    <span className="stat-key">{label}</span>
    <ProgressBar percent={percent} />
    <span className="stat-value">{percent.toFixed(1)}%</span>
  </div>
);

export default StatBar;
