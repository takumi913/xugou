import assert from "node:assert/strict";
import { createInstance } from "i18next";
import enUS from "../src/i18n/en-US";
import zhCN from "../src/i18n/zh-CN";

function flatten(
  value: unknown,
  prefix = "",
  output: Record<string, string> = {}
) {
  if (typeof value === "string") {
    output[prefix] = value;
    return output;
  }
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  for (const [key, child] of Object.entries(value)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, output);
  }
  return output;
}

const locales = {
  "en-US": flatten(enUS.translation),
  "zh-CN": flatten(zhCN.translation),
};
const englishKeys = Object.keys(locales["en-US"]).sort();
const chineseKeys = Object.keys(locales["zh-CN"]).sort();
assert.deepEqual(
  chineseKeys,
  englishKeys,
  "English and Chinese resources must expose exactly the same keys"
);

const placeholders = (value: string) =>
  [...value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)]
    .map((match) => match[1])
    .sort();

for (const key of englishKeys) {
  const enValue = locales["en-US"][key];
  const zhValue = locales["zh-CN"][key];
  assert.equal(typeof enValue, "string", `${key} must be a string in en-US`);
  assert.equal(typeof zhValue, "string", `${key} must be a string in zh-CN`);
  assert.deepEqual(
    placeholders(zhValue),
    placeholders(enValue),
    `${key} must use the same interpolation variables in both languages`
  );
  assert.equal(enValue.includes("{{"), false, `${key} uses the obsolete delimiter`);
  assert.equal(zhValue.includes("{{"), false, `${key} uses the obsolete delimiter`);
}

const i18n = createInstance();
await i18n.init({
  resources: {
    "en-US": enUS,
    "zh-CN": zhCN,
  },
  fallbackLng: "zh-CN",
  interpolation: { escapeValue: false, prefix: "{", suffix: "}" },
});

for (const language of Object.keys(locales) as Array<keyof typeof locales>) {
  for (const key of englishKeys) {
    const variables = Object.fromEntries(
      placeholders(locales[language][key]).map(
        (name) => [name, `fixture-${name}`]
      )
    );
    const rendered = i18n.t(key, { lng: language, ...variables });
    assert.equal(
      /\{[A-Za-z_][A-Za-z0-9_]*\}/.test(rendered),
      false,
      `${language}:${key} must render every interpolation variable`
    );
  }
}
