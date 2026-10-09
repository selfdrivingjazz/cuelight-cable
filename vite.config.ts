import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: { editor: resolve(root, "index.html"), guide: resolve(root, "guide/index.html") },
    },
  },
  server: {
    host: "127.0.0.1",
    // `pnpm start` serves the API; `pnpm dev` proxies to it.
    proxy: { "/api": `http://127.0.0.1:${process.env.PORT ?? "4190"}` },
  },
  test: { include: ["src/**/*.test.{ts,tsx}"] },
});
