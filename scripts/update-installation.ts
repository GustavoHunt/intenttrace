import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  CloudflareAPI,
  advance,
  bytes,
  validateRelease,
  type Receipt,
  type PrivateState,
} from "../installer/core";

// Owner maintenance after installation has revoked its temporary OAuth grant.
// Existing application secrets stay inside Cloudflare.
async function main() {
  const [receiptPath, ...flags] = process.argv.slice(2);
  if (!receiptPath)
    throw new Error(
      "Provide a local installation receipt and optionally --wrangler-login.",
    );
  const receipt: Receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  if (
    !/^[a-f0-9]{32}$/.test(receipt.accountId) ||
    !/^intenttrace-[a-f0-9]{12}$/.test(receipt.name) ||
    receipt.phase !== 10
  )
    throw new Error(
      "A completed IntentTrace installation receipt is required.",
    );
  let token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token && flags.includes("--wrangler-login")) {
    const config = await readFile(
      homedir() + "/.wrangler/config/default.toml",
      "utf8",
    );
    token = config.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
  }
  if (!token)
    throw new Error(
      "Use a Cloudflare token in your environment or explicitly select --wrangler-login.",
    );
  const api = new CloudflareAPI(token);
  const script = `/accounts/${receipt.accountId}/workers/scripts/${receipt.name}`;
  const settings = await api.call<{
    bindings: Record<string, any>[];
    compatibility_date: string;
    compatibility_flags: string[];
  }>(script + "/settings");
  const current = settings.bindings.find(
    (b) => b.name === "INSTALL_RELEASE",
  )?.text;
  const release = await validateRelease(
    JSON.parse(await readFile("installer/public/release.json", "utf8")),
  );
  const previousUpdate = await readFile(receiptPath + ".update.json", "utf8")
    .then(JSON.parse)
    .catch(() => null);
  const recordedUpdate =
    previousUpdate?.worker === receipt.name
      ? previousUpdate.release
      : undefined;
  if (
    current !== receipt.releaseHash &&
    current !== recordedUpdate &&
    current !== release.sha256
  )
    throw new Error(
      "Deployment changed since this receipt. Review it before updating.",
    );
  const uploadReceipt = { ...receipt, phase: 5, releaseHash: release.sha256 };
  const state: PrivateState = { signingSecret: "" };
  await advance(api, uploadReceipt, state, release, async () => {});
  const bindings = settings.bindings
    .filter((b) => b.type !== "secret_text")
    .map((b) =>
      b.name === "INSTALL_RELEASE" ? { ...b, text: release.sha256 } : b,
    );
  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({
      main_module: release.main,
      compatibility_date: settings.compatibility_date,
      compatibility_flags: settings.compatibility_flags,
      bindings,
      keep_bindings: ["secret_text"],
      assets: {
        jwt: state.assetJwt,
        config: {
          not_found_handling: "single-page-application",
          run_worker_first: ["/api/*", "/agents/*"],
        },
      },
      observability: { enabled: true },
    }),
  );
  for (const module of release.modules)
    form.set(
      module.name,
      new File([bytes(module.content)], module.name, { type: module.type }),
    );
  await api.call(script, "PUT", form);
  await writeFile(
    receiptPath + ".update.json",
    JSON.stringify(
      {
        worker: receipt.name,
        previousRelease: current,
        release: release.sha256,
        deployedAt: new Date().toISOString(),
        validation: "Browser and live checks required after deployment",
      },
      null,
      2,
    ),
  );
  console.log(
    "Application updated. Existing secrets were retained in Cloudflare. Validate the new release before marking it ready.",
  );
}
main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      : "Update failed",
  );
  process.exitCode = 1;
});
