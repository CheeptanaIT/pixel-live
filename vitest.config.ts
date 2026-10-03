import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "shared", include: ["test/shared/**/*.test.ts"], environment: "node" },
        // pure stage/audio logic only: nothing here may touch the DOM
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            // short enough to test the sweep without a 10 s wait; production keeps the config value
            miniflare: { bindings: { HELLO_TIMEOUT_MS: "1000" } },
          }),
        ],
        test: { name: "worker", include: ["test/worker/**/*.test.ts"] },
      },
    ],
  },
});
