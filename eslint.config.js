import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { configs as lit } from "eslint-plugin-lit";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "demo/*.js"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  lit["flat/recommended"],
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "ExportDefaultDeclaration", message: "Use named exports." },
      ],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    files: ["*.js", "*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { process: "readonly", console: "readonly" },
    },
    rules: { ...tseslint.configs.disableTypeChecked.rules, "no-restricted-syntax": "off" },
  },
);
