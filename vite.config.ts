import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { sourceImport } from "./scripts/source-fetch.ts";
export default defineConfig({
  plugins: [
    sourceImport(),
    react(),
    cloudflare({
      configPath: process.env.INTENTTRACE_CONFIG || "wrangler.jsonc",
    }),
  ],
});
