import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { parse } from "jsonc-parser";
import { resolve } from "node:path";

const [command = "local", stage = "local"] = process.argv.slice(2);
if (!["demo", "staging", "local"].includes(stage))
  throw new Error("Choose demo or staging");
const configPath = `wrangler.local.${stage}.jsonc`;
const wrangler = "node_modules/wrangler/bin/wrangler.js";
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], {
      stdio: options.input ? ["pipe", "inherit", "inherit"] : "inherit",
      env: { ...process.env, ...options.env },
    });
    if (options.input) child.stdin.end(options.input);
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Command failed (${code})`)),
    );
  });
}
async function configuration() {
  try {
    return JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    throw new Error(`Run npm run setup -- configure ${stage} first`);
  }
}
if (command === "local" || command === "configure") {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    console.log(
      "Enter public resource identifiers only. Never paste a secret here. Get these from your Cloudflare dashboard.",
    );
    const account = (
      process.env.INTENTTRACE_ACCOUNT_ID ||
      (await prompt.question("Cloudflare account ID: "))
    ).trim();
    const gateway = (
      process.env.INTENTTRACE_GATEWAY_ID ||
      (await prompt.question("AI Gateway ID (same account): "))
    ).trim();
    const sitekey =
      stage === "local"
        ? ""
        : (await prompt.question("Turnstile public sitekey: ")).trim();
    if (
      !/^[a-f0-9]{32}$/.test(account) ||
      !/^[-a-zA-Z0-9_]{1,100}$/.test(gateway) ||
      (stage !== "local" && !/^[-a-zA-Z0-9_]{10,100}$/.test(sitekey))
    )
      throw new Error("Invalid public identifier");
    const config = parse(await readFile("wrangler.jsonc", "utf8"));
    config.name = `intenttrace-${stage}`;
    config.account_id = account;
    config.ai = { binding: "AI", remote: true };
    config.vars = {
      ...config.vars,
      AI_GATEWAY_ID: gateway,
      TURNSTILE_SITE_KEY: sitekey,
      CLEF_MODEL_ID: "@cf/cloudflare/clef",
      LOCAL_DEVELOPMENT: stage === "local" ? "true" : "false",
    };
    config.r2_buckets[0].bucket_name = `intenttrace-${stage}-evidence`;
    config.workflows[0].name = `intenttrace-${stage}-investigate`;
    config.ratelimits =
      stage === "local"
        ? []
        : [
            {
              name: "RATE_LIMITER",
              namespace_id: stage === "demo" ? "1001" : "1002",
              simple: { limit: 60, period: 60 },
            },
          ];
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
    console.log(
      stage === "local"
        ? `Saved ignored ${configPath}. Run npm run dev, then enable Clef in application Settings. R2, Durable Objects and Workflows are emulated locally; only Workers AI uses your account.`
        : `Saved ignored ${configPath}. Next: resources, secrets, then deploy. See README.md for service setup.`,
    );
  } finally {
    prompt.close();
  }
} else if (command === "resources") {
  const config = await configuration();
  await run(wrangler, [
    "r2",
    "bucket",
    "create",
    config.r2_buckets[0].bucket_name,
    "--config",
    configPath,
  ]);
  await run(wrangler, [
    "r2",
    "bucket",
    "lifecycle",
    "add",
    config.r2_buckets[0].bucket_name,
    "expire-evidence",
    "",
    "--expire-days",
    "1",
    "--force",
    "--config",
    configPath,
  ]);
} else if (command === "secrets") {
  await configuration();
  console.log(
    "Paste the secret from Cloudflare Turnstile into Wrangler’s protected secret prompt.",
  );
  await run(wrangler, [
    "secret",
    "put",
    "TURNSTILE_SECRET_KEY",
    "--config",
    configPath,
  ]);
  console.log(
    "Generating a random session signing secret and uploading it directly to Workers Secrets.",
  );
  await run(
    wrangler,
    ["secret", "put", "SESSION_SIGNING_SECRET", "--config", configPath],
    { input: randomBytes(48).toString("base64url") },
  );
} else if (command === "deploy") {
  if (stage === "local")
    throw new Error(
      "Local configuration cannot be deployed. Choose demo or staging explicitly.",
    );
  await configuration();
  await run("node_modules/vite/bin/vite.js", ["build"], {
    env: { INTENTTRACE_CONFIG: configPath },
  });
  const deployed = JSON.parse(
    await readFile(".wrangler/deploy/config.json", "utf8"),
  );
  if (!deployed.configPath)
    throw new Error("Vite did not emit a deployment configuration");
  await run(wrangler, [
    "deploy",
    "--config",
    resolve(".wrangler/deploy", deployed.configPath),
  ]);
} else if (command === "live") {
  await configuration();
  console.log(
    "Connected development makes Workers AI available. Enable Clef in application Settings to use real AI quota. Your existing Cloudflare login supplies credentials; no API key is embedded in the app.",
  );
  await run(wrangler, ["whoami"]);
  await run("node_modules/vite/bin/vite.js", ["--host", "127.0.0.1"], {
    env: { INTENTTRACE_CONFIG: configPath },
  });
} else
  throw new Error(
    "Commands: configure, resources, secrets, deploy, live; followed by demo or staging",
  );
