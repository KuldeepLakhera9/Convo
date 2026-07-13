import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sharedSrc = fileURLToPath(
  new URL("../../packages/shared/src", import.meta.url),
);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@convo/shared": path.join(sharedSrc, "index.ts"),
    },
  },
  server: {
    port: 5180,
    proxy: {
      "/api": {
        target: "http://localhost:3002",
        changeOrigin: true,
      },
    },
  },
});
