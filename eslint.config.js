import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      "no-console": "error",
    },
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: { document: "readonly", window: "readonly", fetch: "readonly", Option: "readonly", confirm: "readonly", prompt: "readonly", URL: "readonly", setTimeout: "readonly", SimpleWebAuthnBrowser: "readonly" },
    },
  },
  {
    files: ["test/**"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
