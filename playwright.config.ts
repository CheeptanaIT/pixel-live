import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  use: { baseURL: "http://localhost:5199", locale: "th-TH" },
  webServer: {
    command: "npx vite --port 5199 --strictPort",
    url: "http://localhost:5199/api/health",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
