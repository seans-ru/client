import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port; do not enable HMR over the network.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    // Plain `npm run dev` (no Tauri): same-origin proxy avoids API CORS.
    proxy: {
      "/api": {
        target: "https://api.seans.tedeshi.ru",
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "chrome105",
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
