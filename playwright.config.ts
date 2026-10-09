import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/integration",
  timeout: 45000,
  fullyParallel: false,
  use: { baseURL: "http://127.0.0.1:63022" },
  webServer: {
    command: "npm run dev -- --port 63022 --strictPort",
    url: "http://127.0.0.1:63022/api/config",
    env: { INTENTTRACE_CONFIG: "wrangler.jsonc" },
    reuseExistingServer: false,
    timeout: 60000,
  },
});
