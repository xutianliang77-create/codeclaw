import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // 全局 ignores 必须独立 config 对象（不含 files/rules/languageOptions）
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".codeclaw/**",
      "test/golden/fix/**",
      "web/vendor/**",
      "web-react/dist/**",
      "web-react/node_modules/**",
    ],
  },
  {
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly"
      }
    }
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      // 允许 _ 前缀的 unused 参数 / 变量（占位 / 保留签名场景）
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ]
    }
  }
);
