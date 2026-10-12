import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  base: "./",
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { outDir: "../dist-web", emptyOutDir: true, target: "es2022" },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
});
