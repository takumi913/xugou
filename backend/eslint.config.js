import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "openapi/**", "src/worker-env.d.ts"],
  },
  {
    files: ["src/**/*.ts", "tooling/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.tooling.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  }
);
