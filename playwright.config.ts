import { defineConfig } from "@playwright/test";

// Point the suite at a deployed site instead of a local dev server:
//   PIXEL_BASE_URL=https://example.workers.dev npx playwright test room audio
// (stage.spec.ts needs the dev-only /dev/stage route and test hooks, so it only runs locally.)
const remote = process.env.PIXEL_BASE_URL;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  // One worker on purpose: each test opens several Chromium pages with WebRTC and software WebGL.
  // Run in parallel they starve each other of CPU and time out (not a product bug, but flaky).
  workers: 1,
  retries: 0,
  use: {
    baseURL: remote ?? "http://localhost:5199",
    locale: "th-TH",
    permissions: ["microphone"],
    // Chromium's synthetic mic emits a periodic beep, so audio really flows without hardware.
    launchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
  },
  webServer: remote
    ? undefined
    : {
        command: "npx vite --port 5199 --strictPort",
        url: "http://localhost:5199/api/health",
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
