import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative base so one build works at any YunoHost install path.
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: { "/api": "http://127.0.0.1:3000" },
  },
});
