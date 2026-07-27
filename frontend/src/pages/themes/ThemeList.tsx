import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import PageLoading from "../../components/PageLoading";
import { getStatusPageConfig, saveStatusPageConfig } from "../../api/status";
import { useTheme } from "../../providers/ThemeProvider";
import { themes, type ThemeManifest } from "../../themes";

/**
 * 主题列表页（后台）：
 * 展示 frontend/src/themes/ 下注册的全部主题，点击「应用」后：
 * 1. 立即切换本地界面主题（localStorage 持久化）；
 * 2. 同步写入状态页配置（status_page_config.theme），公开状态页对所有
 *    访客按此主题渲染。
 */
const ThemeList = () => {
  const { t } = useTranslation();
  const { themeId, setThemeId } = useTheme();
  const [loading, setLoading] = useState(true);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  // 服务端（状态页）当前保存的主题，用于展示同步状态
  const [serverTheme, setServerTheme] = useState<string | null>(null);

  // 进入页面时拉一次服务端配置，展示状态页当前保存的主题
  useEffect(() => {
    const abortController = new AbortController();
    (async () => {
      try {
        const config = await getStatusPageConfig(abortController.signal);
        if (abortController.signal.aborted) return;
        setServerTheme(config?.theme || "mono");
      } catch {
        if (!abortController.signal.aborted) setServerTheme(null);
      } finally {
        if (!abortController.signal.aborted) setLoading(false);
      }
    })();
    return () => abortController.abort();
  }, []);

  const applyTheme = async (theme: ThemeManifest) => {
    // 本地立即生效
    setThemeId(theme.id);
    setApplyingId(theme.id);
    try {
      // 读取完整配置再带 theme 保存（配置接口是整体保存语义）
      const config = await getStatusPageConfig();
      const response = await saveStatusPageConfig({
        title: config?.title || t("statusPage.title"),
        description: config?.description || "",
        logoUrl: config?.logoUrl || "",
        customCss: config?.customCss || "",
        theme: theme.id,
        monitors: (config?.monitors || [])
          .filter((monitor) => monitor.selected)
          .map((monitor) => monitor.id),
        agents: (config?.agents || [])
          .filter((agent) => agent.selected)
          .map((agent) => agent.id),
      });
      if (response) {
        setServerTheme(theme.id);
        toast.success(t("themes.applied", { name: theme.name }));
      } else {
        toast.error(t("themes.syncFailed"));
      }
    } catch {
      // 本地已生效，仅同步状态页失败
      toast.error(t("themes.syncFailed"));
    } finally {
      setApplyingId(null);
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <PageLoading />
      </div>
    );
  }

  return (
    <div className="page-container">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h1 className="prompt-title">{t("themes.title")}</h1>
      </div>
      <p className="mb-4 text-xs" style={{ color: "var(--text-secondary)" }}>
        {t("themes.description")}
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {themes.map((theme) => {
          const isCurrent = theme.id === themeId;
          return (
            <div key={theme.id} className="terminal-card flex flex-col p-4">
              {/* 色板预览条 */}
              <div
                className="mb-3 flex h-10 overflow-hidden rounded"
                style={{ border: "1px solid var(--border-color)" }}
              >
                {theme.preview.map((color, index) => (
                  <div
                    key={`${color}-${index}`}
                    className="flex-1"
                    style={{ background: color }}
                  />
                ))}
              </div>

              <div className="flex items-center justify-between gap-2">
                <span
                  className="truncate font-semibold"
                  style={{ color: "var(--text-primary)" }}
                >
                  {theme.name}
                </span>
                {isCurrent && (
                  <span
                    className="status-label"
                    style={{
                      color: "var(--accent-green)",
                      borderColor: "var(--accent-green)",
                      flexShrink: 0,
                    }}
                  >
                    {t("themes.current")}
                  </span>
                )}
              </div>

              <div
                className="mt-1 flex items-center gap-2 text-xs"
                style={{ color: "var(--text-secondary)" }}
              >
                <span className="tag-badge">{theme.id}</span>
                {theme.version && <span>v{theme.version}</span>}
                {theme.author && <span>@{theme.author}</span>}
              </div>

              <p
                className="mt-2 flex-1 text-xs"
                style={{ color: "var(--text-secondary)" }}
              >
                {theme.description}
              </p>

              <div className="mt-3 flex items-center justify-between gap-2">
                <span
                  className="text-xs"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {serverTheme === theme.id ? t("themes.statusPageSynced") : ""}
                </span>
                <Button
                  variant={isCurrent ? "secondary" : "default"}
                  disabled={isCurrent || applyingId !== null}
                  onClick={() => applyTheme(theme)}
                >
                  {applyingId === theme.id
                    ? t("themes.applying")
                    : isCurrent
                    ? t("themes.current")
                    : t("themes.apply")}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-6 text-xs" style={{ color: "var(--text-secondary)" }}>
        {t("themes.extendHint")}
        <code className="tag-badge ml-1">frontend/src/themes/README.md</code>
      </p>
    </div>
  );
};

export default ThemeList;
