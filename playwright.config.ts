import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/integration",
  timeout: 45000,
  fullyParallel: false,
  use: { baseURL: "http://127.0.0.1:5173" },
  webServer: {
    command: "npm run dev -- --port 5173",
    url: "http://127.0.0.1:5173/api/config",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
