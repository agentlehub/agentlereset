import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "promise"],
  env: {
    node: true,
    browser: false,
  },
  categories: {
    correctness: "error",
    suspicious: "warn",
  },
  options: {
    typeAware: true,
  },
  rules: {
    "typescript/no-floating-promises": ["error", { ignoreVoid: false }],
    "typescript/no-misused-promises": "error",
    "typescript/await-thenable": "error",
    "no-console": ["error", { allow: ["warn", "error"] }],
  },
  ignorePatterns: ["node_modules/**", "dist/**", "coverage/**"],
});
