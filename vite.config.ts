import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4184",
      "/actions": "http://localhost:4184",
      "/auth": "http://localhost:4184",
      "/healthz": "http://localhost:4184",
      "/.well-known": "http://localhost:4184"
    }
  }
});
