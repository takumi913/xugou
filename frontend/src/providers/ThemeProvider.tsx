import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  ReactNode,
} from "react";

import {
  DEFAULT_THEME_ID,
  getThemeById,
  isKnownThemeId,
  type ThemeManifest,
} from "../themes";

export type ThemePreference = "dark" | "light" | "auto";
export type ResolvedTheme = "dark" | "light";

// 注意：key 与 index.html 内联防闪烁脚本读取的 key 保持同步
const STORAGE_KEY = "theme_preference";
const THEME_ID_STORAGE_KEY = "theme_id";
const THEME_ORDER: ThemePreference[] = ["dark", "light", "auto"];

// 跟随系统明暗偏好：系统为浅色时返回 light，否则返回 dark（终端风格默认深色）
const getSystemTheme = (): ResolvedTheme => {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }
  return "dark";
};

const readStoredTheme = (): ThemePreference => {
  if (typeof window === "undefined") return "auto";
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "dark" || stored === "light" || stored === "auto"
    ? stored
    : "auto";
};

const resolveTheme = (theme: ThemePreference): ResolvedTheme =>
  theme === "auto" ? getSystemTheme() : theme;

// 深色为默认（:root 裸跑），浅色通过在 html 上挂 .light 类启用
const applyTheme = (resolved: ResolvedTheme) => {
  document.documentElement.classList.toggle("light", resolved === "light");
};

// 用户选择的主题 id（localStorage；未知 id 回退默认主题）
const readStoredThemeId = (): string => {
  if (typeof window === "undefined") return DEFAULT_THEME_ID;
  const stored = localStorage.getItem(THEME_ID_STORAGE_KEY);
  return isKnownThemeId(stored) ? stored : DEFAULT_THEME_ID;
};

// 主题通过 html[data-theme] 生效（各主题的变量块按此选择器打包在主 CSS 内）
const applyThemeId = (themeId: string) => {
  document.documentElement.dataset.theme = themeId;
};

interface ThemeContextType {
  theme: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemePreference) => void;
  toggleTheme: () => ThemePreference;
  /** 用户选择的主题 id（持久化） */
  themeId: string;
  /** 当前实际生效的主题清单（override 优先，供图表等取色） */
  activeTheme: ThemeManifest;
  /** 切换主题（持久化到 localStorage；未知 id 忽略） */
  setThemeId: (id: string) => void;
  /**
   * 临时覆盖主题（不持久化）：公开状态页按站长所选主题渲染时使用，
   * 传 null 恢复用户自己的主题
   */
  setThemeOverride: (id: string | null) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [theme, setThemeState] = useState<ThemePreference>(readStoredTheme);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(readStoredTheme())
  );
  const [themeId, setThemeIdState] = useState<string>(readStoredThemeId);
  const [overrideThemeId, setOverrideThemeId] = useState<string | null>(null);

  const setTheme = useCallback((next: ThemePreference) => {
    localStorage.setItem(STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  const setThemeId = useCallback((id: string) => {
    if (!isKnownThemeId(id)) return;
    localStorage.setItem(THEME_ID_STORAGE_KEY, id);
    setThemeIdState(id);
  }, []);

  const setThemeOverride = useCallback((id: string | null) => {
    // 未知 id 的覆盖按默认主题处理（公开状态页可能带到已删除的主题 id）
    setOverrideThemeId(id === null ? null : getThemeById(id).id);
  }, []);

  // 生效主题 = 页面级覆盖优先，其次用户选择
  const effectiveThemeId = overrideThemeId ?? themeId;
  useEffect(() => {
    applyThemeId(effectiveThemeId);
  }, [effectiveThemeId]);

  // 三档循环：dark -> light -> auto -> dark
  const toggleTheme = useCallback(() => {
    const next =
      THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    setTheme(next);
    return next;
  }, [theme, setTheme]);

  useEffect(() => {
    const resolved = resolveTheme(theme);
    setResolvedTheme(resolved);
    applyTheme(resolved);

    // auto 档实时响应系统明暗变化
    if (theme !== "auto" || typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
    const handleChange = () => {
      const next = resolveTheme("auto");
      setResolvedTheme(next);
      applyTheme(next);
    };
    // 兼容旧版 Safari：addListener 已废弃但部分浏览器仍需
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange);
    } else {
      mediaQuery.addListener(handleChange);
    }
    return () => {
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener("change", handleChange);
      } else {
        mediaQuery.removeListener(handleChange);
      }
    };
  }, [theme]);

  const value = useMemo(
    () => ({
      theme,
      resolvedTheme,
      setTheme,
      toggleTheme,
      themeId,
      activeTheme: getThemeById(effectiveThemeId),
      setThemeId,
      setThemeOverride,
    }),
    [
      theme,
      resolvedTheme,
      setTheme,
      toggleTheme,
      themeId,
      effectiveThemeId,
      setThemeId,
      setThemeOverride,
    ]
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
};

export const useTheme = (): ThemeContextType => {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
};
