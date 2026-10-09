import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { sourceImport } from "./scripts/source-fetch.ts";
import { existsSync } from "node:fs";
export default defineConfig({
  plugins: [
    sourceImport(),
    react(),
    cloudflare({
      configPath:
        process.env.INTENTTRACE_CONFIG ||
        (existsSync("wrangler.local.local.jsonc")
          ? "wrangler.local.local.jsonc"
          : "wrangler.jsonc"),
    }),
  ],
});
