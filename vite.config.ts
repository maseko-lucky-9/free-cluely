import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The production renderer is loaded over file:// (WindowHelper.ts), so asset
  // URLs must be relative. With Vite's default base of "/", "/assets/index.js"
  // resolves to the filesystem root and the window comes up blank.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5180,
  },
});
