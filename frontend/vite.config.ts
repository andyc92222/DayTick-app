import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api/auth": "http://127.0.0.1:8001",
      "/api/tasks": "http://127.0.0.1:8002",
      "/api/timers": "http://127.0.0.1:8003",
    },
  },
});
