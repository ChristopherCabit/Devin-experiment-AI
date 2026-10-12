import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "dist-web/", "src-tauri/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      "no-console": "error",
    },
  },
  {
    files: ["test/**"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
