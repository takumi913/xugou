import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "openapi/**", "src/worker-env.d.ts"],
  },
  {
    files: [
      "src/**/*.ts",
      "tooling/**/*.ts",
      "scripts/**/*.ts",
      "test-runtime/**/*.ts",
      "vitest.config.ts",
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: [
          "./tsconfig.json",
          "./tsconfig.tooling.json",
          "./tsconfig.test-runtime.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  }
);
