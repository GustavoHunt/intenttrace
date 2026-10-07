# Optional OAuth installer prototype

The primary delivery is the GitHub download and localhost app. Ordinary users do not need this prototype. See [local setup](INSTALLATION.md).

The guided installer uses Cloudflare OAuth with PKCE. A user approves permissions on Cloudflare, selects an authorized account, then chooses **Create my instance**. Cloudflare account registration, billing prerequisites such as R2 activation, and organizational restrictions remain Cloudflare steps; the app cannot silently complete them.

## What the installer creates

Each installation gets a random `intenttrace-<12 hex characters>` prefix. The installer checks for a Worker name collision before creating anything. It creates a private R2 evidence bucket with a one-day expiration rule, a dedicated AI Gateway with content logging and caching disabled, a managed Turnstile widget for the exact workers.dev hostname, a Worker with static assets and three SQLite Durable Object classes, and an investigation Workflow. Workers AI and Browser Run use native bindings. Application signing and Turnstile credentials are sent directly to Workers Secrets.

The installation receipt contains resource names, the release checksum, progress and verification results. It contains no access token or application secret. An interrupted step can be retried during the same 30-minute session. Partial resources remain in the selected account; the installer never deletes unrelated resources or automatically rolls back infrastructure. Download the receipt before closing the session. After expiration, use the receipt to inspect partial resources in Cloudflare; starting again creates a new installation rather than claiming the old one.

## Configure an installer operator

An OAuth client is an operator prerequisite, not something every demo user creates.

1. Install dependencies with `npm ci`, then run `npm run installer:package`. This builds the exact application release served by the installer. The generated release is ignored by Git and must be rebuilt from source when deploying the installer. Keep a release fixed while installations are in progress.
2. In the intended Cloudflare account, open **Manage account → OAuth clients** and create a client. For local validation use a private client, authorization-code grant, code response, and **None (PKCE)** token authentication. Set the redirect URI to exactly `http://127.0.0.1:8788/oauth/callback`. A public installer requires the appropriate public-client registration and domain ownership verification in Cloudflare. Use the exact HTTPS callback on the deployed domain.
3. Configure these required scopes: `account-settings.read`, `workers-scripts.write` (**Workers Scripts Write**), `workers-r2.write`, `ai.write`, `aig.read`, `aig.write`, and `challenge-widgets.write`. Account-level permissions are broader than one installation's resources. The application restricts its operations to installation-specific names; OAuth does not enforce that prefix. In local validation, the dashboard exposed **Workers Editor** (`workers-scripts.edit`), which did not authorize asset uploads. Do not substitute it. If the dashboard omits Workers Scripts Write, an operator must configure the client through Cloudflare's OAuth Client API, using a temporary token with **OAuth Client Write** on only the operator account. Supply that token privately through `CLOUDFLARE_OAUTH_ADMIN_TOKEN`, run `npx tsx scripts/configure-oauth.ts <account-id> <client-id>`, then revoke the administration token in Cloudflare. This administrative token is separate from the end user's deployment grant.
4. Copy `installer/.dev.vars.example` to the ignored `installer/.dev.vars`. Enter the client ID from Cloudflare and generate a cryptographically random encryption secret of at least 32 bytes. Never place either secret in source control. A PKCE client with authentication **None** needs no client secret. If the client uses secret authentication, obtain that value through Cloudflare and set `OAUTH_CLIENT_SECRET` privately too.
5. Run `npm run installer:dev`, then open `http://127.0.0.1:8788`. Use that hostname consistently; `localhost` is a different cookie origin and callback.
6. For hosting, set `INSTALLER_ORIGIN` to the actual HTTPS origin and the public `OAUTH_CLIENT_ID` in your deployment configuration. Supply `ENCRYPTION_SECRET` and any required `OAUTH_CLIENT_SECRET` through **Workers & Pages → installer Worker → Settings → Variables and Secrets**, using type **Secret**, or Wrangler's protected `secret put` prompt with `--config installer/wrangler.jsonc`. Deploy the installer with the same configuration after rebuilding the release. Ensure the OAuth callback exactly matches the registered URI. Do not commit a personal account ID or deployment configuration.

The repository does not ship a shared public installer URL or someone else's OAuth client ID. Publishing this repository alone does not register an OAuth application.

## Connect and verify

Choose **Connect Cloudflare**, select only the account where resources should be created, review permissions, and authorize. Back in IntentTrace, choose **Create my instance**. Enable R2 in **Storage & databases → R2** if the preflight requests it, then retry. An existing workers.dev subdomain is also required.

The final check uses an owner-authenticated endpoint and fixed synthetic input. It verifies private storage, Agent memory, a real Workflow, live Workers AI through the configured AI Gateway, and Browser Run rendering a fixed HTML page. It accepts neither an arbitrary URL nor executable input. A pending workflow stays pending; an unavailable model does not count as success. A successful installation revokes its temporary Cloudflare access and clears the installer-held credential copy. The installed app then runs through its own Cloudflare bindings.

Open the app, complete its managed Turnstile check, and exercise the case desk and a chat question. Service verification and a successful human browser session are distinct checks.

## Credential lifecycle and recovery

The browser has an HttpOnly, same-site session cookie. Authorization codes and access tokens are exchanged server-side. Temporary credentials are encrypted with AES-GCM in an installation-specific Durable Object and bound to that session. OAuth state is single-use and PKCE binds the code to its original request. Provider redirects are rejected without forwarding credentials. Installer request logging is disabled because callbacks contain short-lived authorization codes.

Choose **Disconnect Cloudflare** to revoke access early. On expiration an alarm attempts revocation and deletes the local credential vault. Provider revocation is not guaranteed during an outage; verify or revoke the application in **My Profile → Access Management → Connected Applications** if needed. Do not log raw callback URLs, provider bodies, or credential files. Rotating the installer encryption secret during an active session makes that vault unreadable; revoke its grant in Cloudflare.

The optional `npm run installer:check -- <account-id> --wrangler-login` command checks an existing local Wrangler login without printing its token. Wrangler's default grant may lack OAuth-client administration or AI Gateway permissions. The CLI installer can use `CLOUDFLARE_API_TOKEN` supplied through the local environment, but its ignored `.local` recovery file temporarily contains application secrets. Prefer the encrypted OAuth flow. Never upload `.local`, `.wrangler`, `.dev.vars`, tokens, or exported browser state.

## Cloudflare references

- [Create an OAuth client](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)
- [OAuth integration endpoints](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/)
- [Authorizing an application](https://developers.cloudflare.com/fundamentals/oauth/authorizing-an-application/)
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## Updating an installed app

After a successful installation, the installer revokes its grant. For owner maintenance, keep the downloaded installation receipt locally, run `npx wrangler login` if necessary, then:

```sh
npm run installer:package
npx tsx scripts/update-installation.ts /path/to/intenttrace-installation.json --wrangler-login
```

Alternatively supply `CLOUDFLARE_API_TOKEN` in your local environment and omit `--wrangler-login`. The command checks the account, the IntentTrace resource name and the recorded release before updating. Existing application secrets stay in Cloudflare; it does not retrieve their values. An adjacent `.update.json` records the deployed release. Validate the app in a browser after updating; an upload receipt is not a new live-check result.

If installation is still waiting at verification and the operator publishes a repaired release, **Update application and retry** explicitly adopts that release, preserves the original release hash in the receipt, and reuses the resources already created. A normal retry never silently switches releases. Model-check recovery is bounded to three attempts.
