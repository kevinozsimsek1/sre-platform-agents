import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Portal, gateway'in kök yolunda ("/") açılır ama dosyaları /_portal/ altından gelir.
// Böylece agent UI'larının kök yola düşen istekleri (/app.js, /chat, ...) ile çakışmaz.
export default defineConfig({
  base: "/_portal/",
  plugins: [react(), tailwindcss()],
  server: {
    // Yerel geliştirme: API'yi 8000'de çalıştır (README'ye bak).
    // Agent'lar için: `kubectl port-forward -n mcp-llm-agent svc/agent-gateway 8080:80`
    proxy: {
      "/_portal/api": "http://localhost:8000",
      "/cloudwatch": "http://localhost:8080",
      "/eks": "http://localhost:8080",
    },
  },
});
