import { execSync } from "node:child_process";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Short hash of HEAD at dev/build start (issue #73), baked into
 * `import.meta.env.VITE_APP_COMMIT`. No git (tarball / CI without a repo) →
 * empty string, never a build failure.
 */
function readAppCommit(): string {
  try {
    return execSync("git rev-parse --short=7 HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

// Tauri expects a fixed dev port; do not enable HMR over the network.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: {
    "import.meta.env.VITE_APP_COMMIT": JSON.stringify(readAppCommit()),
  },
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
