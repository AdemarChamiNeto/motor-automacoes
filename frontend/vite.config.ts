/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, proxy: { "/api": "http://localhost:3002", "/hooks": "http://localhost:3002" } },
  test: { globals: true, environment: "jsdom", setupFiles: ["./src/test-setup.ts"], css: false },
});
