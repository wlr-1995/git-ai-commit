import { defineConfig } from "electron-vite"

export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: "src/main/index.ts" } } },
  },
  preload: {
    build: { rollupOptions: { input: { index: "src/preload/index.ts" } } },
  },
  renderer: {
    root: "src/renderer",
    build: { rollupOptions: { input: { index: "src/renderer/index.html" } } },
  },
})
