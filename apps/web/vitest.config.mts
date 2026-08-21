import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// jsdom for every test in this app, not just component tests -- plain
// logic tests (portfolio-series, format-currency) run fine under jsdom
// too, so one environment keeps this config simple rather than juggling
// environmentMatchGlobs for a handful of files.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirrors tsconfig.json's "@/*" -> "./src/*" path alias -- Vite/Vitest
    // don't read tsconfig paths on their own.
    alias: { "@": path.resolve(dirname, "src") },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
  },
});
