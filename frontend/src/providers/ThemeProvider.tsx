import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  ReactNode,
} from "react";

export type ThemePreference = "dark" | "light" | "auto";
export type ResolvedTheme = "dark" | "light";

// 注意：key 与 index.html 内联防闪烁脚本读取的 "theme_preference" 保持同步
const STORAGE_KEY = "theme_preference";
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

interface ThemeContextType {
  theme: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemePreference) => void;
  toggleTheme: () => ThemePreference;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [theme, setThemeState] = useState<ThemePreference>(readStoredTheme);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(readStoredTheme())
  );

  const setTheme = useCallback((next: ThemePreference) => {
    localStorage.setItem(STORAGE_KEY, next);
    setThemeState(next);
  }, []);

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
    () => ({ theme, resolvedTheme, setTheme, toggleTheme }),
    [theme, resolvedTheme, setTheme, toggleTheme]
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
