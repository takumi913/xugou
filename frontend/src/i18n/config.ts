import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import zhCN from "./zh-CN";
import enUS from "./en-US";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      "zh-CN": zhCN,
      "en-US": enUS,
    },
    fallbackLng: "zh-CN",
    interpolation: {
      escapeValue: false, // 不转义 React 中的值
      prefix: "{",
      suffix: "}",
    },

    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "i18nextLng",
      caches: ["localStorage"],
    },
  });

export default i18n;
