import { useTranslation } from "react-i18next";

/**
 * 路由懒加载 / 页面数据加载时的统一加载态
 * 终端风格：`$ 加载中...`（等宽字体、次级文字色、居中）
 */
const PageLoading = () => {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[50vh] w-full items-center justify-center font-mono text-[13px] text-[var(--text-secondary)]">
      <span>
        <span className="text-[var(--accent-green)]">$ </span>
        {t("common.loading")}
      </span>
    </div>
  );
};

export default PageLoading;
