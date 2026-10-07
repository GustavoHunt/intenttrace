import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { advance, CloudflareAPI, makeReceipt, PHASES, random, SetupError, validateRelease, type Receipt, type PrivateState, type Release } from "../installer/core";

// Local operator tool only. No credential values are printed or placed in public configuration.
const [command = "check", accountId, ...flags] = process.argv.slice(2);
if (!["check", "install"].includes(command) || !/^[a-f0-9]{32}$/.test(accountId || "")) throw new Error("Usage: npm run installer:check -- <account-id> [--wrangler-login] or npm run installer:install -- <account-id> [--wrangler-login]");
async function credential() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  if (!flags.includes("--wrangler-login")) throw new Error("Set CLOUDFLARE_API_TOKEN in your local environment or explicitly choose --wrangler-login. Never paste credentials into source files.");
  const text = await readFile(resolve(homedir(), ".wrangler/config/default.toml"), "utf8");
  const token = text.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
  if (!token) throw new Error("Wrangler login is unavailable. Run wrangler login first.");
  return token;
}
try {
  const api = new CloudflareAPI(await credential());
  if (command === "check") {
    let failures = 0;
    for (const [label, path] of [["Account", `/accounts/${accountId}`], ["R2", `/accounts/${accountId}/r2/buckets`], ["Worker address", `/accounts/${accountId}/workers/subdomain`], ["AI Gateway", `/accounts/${accountId}/ai-gateway/gateways`], ["Turnstile", `/accounts/${accountId}/challenges/widgets`], ["OAuth client administration (operator only)", `/accounts/${accountId}/oauth_clients`]]) {
      try { await api.call(path); console.log(`${label}: available`); } catch(e) { failures++; console.log(`${label}: ${e instanceof SetupError ? e.message : "Check failed"}`); }
    }
    process.exitCode = failures ? 1 : 0;
  } else {
    const release = await validateRelease(JSON.parse(await readFile("installer/public/release.json", "utf8")) as Release);
    await mkdir(".local", { recursive: true });
    const path = `.local/installation-${accountId}.json`;
    let receipt: Receipt, secrets: PrivateState;
    try { const prior = JSON.parse(await readFile(path, "utf8")); receipt = prior.receipt; secrets = prior.secrets; if (receipt.accountId !== accountId) throw new Error("Receipt account mismatch"); }
    catch(e: any) { if (e.code !== "ENOENT") throw e; receipt = makeReceipt(accountId, release); secrets = { signingSecret: random() + random() }; }
    const save = () => writeFile(path, JSON.stringify({ receipt, secrets }, null, 2), { mode: 0o600 });
    await save();
    while (receipt.phase < PHASES.length) {
      console.log(`${receipt.phase + 1}/${PHASES.length}: ${PHASES[receipt.phase]}`);
      const previous = receipt.phase;
      await advance(api, receipt, secrets, release, save);
      if (receipt.phase === previous) await new Promise(resolve => setTimeout(resolve, 3000));
    }
    // Remove setup credentials once verified. The public receipt contains only resource IDs/checks.
    await writeFile(path, JSON.stringify({ receipt, secrets: {} }, null, 2), { mode: 0o600 });
    console.log(`Verified: ${receipt.url}`);
  }
} catch(e) {
  console.error(e instanceof SetupError ? e.message : "Local installation stopped. Check the configuration and retry; credential values have been withheld.");
  process.exitCode = 1;
}
