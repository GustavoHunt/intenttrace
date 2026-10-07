import { readFile } from "node:fs/promises";
import { SCOPES, CloudflareAPI, SetupError } from "../installer/core";

// Operator-only scope repair. Never stores or prints the administration token.
const [account, client, tokenFile] = process.argv.slice(2);
try {
  if (
    !/^[a-f0-9]{32}$/.test(account || "") ||
    !/^[a-f0-9]{32}$/.test(client || "")
  )
    throw new SetupError("Provide the account ID and OAuth client ID.");
  const token =
    process.env.CLOUDFLARE_OAUTH_ADMIN_TOKEN ||
    (tokenFile ? (await readFile(tokenFile, "utf8")).trim() : "");
  if (!token)
    throw new SetupError(
      "Provide a temporary OAuth Client Write token through CLOUDFLARE_OAUTH_ADMIN_TOKEN or an ignored local file. Never pass a token as a command-line argument.",
    );
  if (!/^[A-Za-z0-9._-]+$/.test(token))
    throw new SetupError(
      "The input must contain only the token, not Cloudflare's example verification command.",
    );
  const api = new CloudflareAPI(token);
  await api.call(`/accounts/${account}/oauth_clients/${client}`, "PATCH", {
    scopes: SCOPES,
    optional_scopes: [],
  });
  const result = await api.call<{ scopes: string[] }>(
    `/accounts/${account}/oauth_clients/${client}`,
  );
  if (!SCOPES.every((scope) => result.scopes.includes(scope)))
    throw new SetupError("Cloudflare did not confirm all required scopes.");
  console.log(
    "OAuth client scopes verified. Revoke the temporary administration token in Cloudflare, then reconnect the installer.",
  );
} catch (error) {
  console.error(
    error instanceof SetupError
      ? error.message
      : "OAuth configuration failed. No credential values have been printed.",
  );
  process.exitCode = 1;
}
