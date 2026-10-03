import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  // One worker on purpose: each test opens several Chromium pages with WebRTC and software WebGL.
  // Run in parallel they starve each other of CPU and time out (not a product bug, but flaky).
  workers: 1,
  retries: 0,
  use: {
    baseURL: "http://localhost:5199",
    locale: "th-TH",
    permissions: ["microphone"],
    // Chromium's synthetic mic emits a periodic beep, so audio really flows without hardware.
    launchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
  },
  webServer: {
    command: "npx vite --port 5199 --strictPort",
    url: "http://localhost:5199/api/health",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
