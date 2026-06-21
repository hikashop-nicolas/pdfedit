import { defineConfig } from "vite";

// Serves and builds the standalone demo (demo/index.html). The library itself is
// built separately with tsc. base "./" so the built demo works under a repo subpath
// on GitHub Pages; output goes to demo-dist/ at the repo root.
export default defineConfig({
  root: "demo",
  base: "./",
  build: {
    outDir: "../demo-dist",
    emptyOutDir: true,
    target: "es2022",
  },
  server: { open: false },
  test: {
    root: ".",
    include: ["src/**/*.test.ts"],
  },
});
