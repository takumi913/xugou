import { useTranslation } from "react-i18next";

interface LiveIndicatorProps {
  connected: boolean;
  /** 最近样本的回放滞后（秒）；>2s 时在 live 后追加 (+Ns) 标记 */
  lagSeconds?: number;
}

/**
 * WebSocket 连接状态小指示（终端风格）：● live / - offline
 * 连接正常但样本滞后 >2s 时显示 ● live (+Ns)
 */
const LiveIndicator = ({ connected, lagSeconds }: LiveIndicatorProps) => {
  const { t } = useTranslation();
  const label = connected ? t("live.connected") : t("live.disconnected");
  const showLag =
    connected && typeof lagSeconds === "number" && lagSeconds > 2;

  return (
    <span
      className="text-xs tracking-wider"
      style={{
        color: connected ? "var(--accent-green)" : "var(--text-secondary)",
      }}
      title={label}
      aria-live="polite"
    >
      {connected ? "●" : "-"} {label}
      {showLag && (
        <span style={{ color: "var(--text-secondary)" }}>
          {" "}
          (+{Math.floor(lagSeconds)}s)
        </span>
      )}
    </span>
  );
};

export default LiveIndicator;
