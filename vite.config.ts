import { defineConfig } from "vite";

// Serves the standalone demo (demo/index.html). The library itself is built with tsc.
export default defineConfig({
  root: "demo",
  server: { open: false },
});
