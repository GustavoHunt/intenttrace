# Local setup

Download and extract the GitHub ZIP, or clone the repository. Install Node.js 22.13+ from its official distribution. Run commands from the directory containing `package.json`.

## Without credentials

```sh
npm ci
npm run dev
```

Open the printed localhost URL. Clef starts off in **Settings**. Intake, storage, offline chat and CSV checks work locally; general reviews remain insufficient evidence without a model assessment. No credential prompt or remote provisioning occurs.

## With real Workers AI

```sh
npx wrangler login
```

Complete Cloudflare's own login. Wrangler retains credentials in its private local configuration, outside the repository. If you belong to several accounts, choose the intended account ID when configuring the app.

In the Cloudflare dashboard:

1. Copy your account's **Account ID**.
2. Open **AI → AI Gateway → Create Gateway**. Create one in the same account, copy its ID, and disable persistent prompt/response logging and caching. Code also requests `collectLog: false` and `skipCache: true`. No Gateway API token is passed by the native Workers AI binding path.
3. Confirm Workers AI is available and review usage/pricing. Complete any service activation or billing steps within Cloudflare.

```sh
npm run setup:local
npm run dev
```

Setup asks for **public IDs only** and writes ignored `wrangler.local.local.jsonc`. No app secret is needed on localhost: a random signing key is generated and persisted in local session storage. Local mode refuses requests addressed to public hostnames. Keep the server bound to `127.0.0.1`; do not expose it through a tunnel or reverse proxy.

`npm run dev` detects the ignored local connection file. After this initial restart, use **Settings → Use Clef and live AI** to switch in real time. The setting is server-enforced, belongs to your 24-hour session, and survives a page refresh. It controls Clef assessments and Llama assistance. Turning it off affects new requests; a started assessment keeps its captured mode. Old `MODE` environment values are ignored. The legacy `dev:offline` command is just a startup alias, and `dev:live` adds a login check; neither overrides the app setting.

Creating or reopening a conversation case opens **Timeline**. The optional guided tour highlights the actual requirements and assessment actions, waits for confirmation, directs you to artifacts or Settings when needed, then points to findings. **Skip tour** is remembered in this browser; **Guided tour** replays it.

R2, SQLite Durable Objects and Workflows are emulated under `.wrangler`. Only the remote AI binding sends requests to Cloudflare. No deployed Worker, R2 activation, Turnstile widget, OAuth client or administration token is required.

For automation, supply public IDs with `INTENTTRACE_ACCOUNT_ID` and `INTENTTRACE_GATEWAY_ID`. If using an API token instead of browser login, create it through Cloudflare with the necessary account permissions and inject it privately as `CLOUDFLARE_API_TOKEN` in your environment or CI secret store. Never place it in a command argument, source, report or commit. Browser login is the tested route.

## Troubleshooting

- **Remote session authentication failed:** run `npx wrangler whoami`, then restart. If refresh fails, use `npx wrangler login` again. `dev:live` checks login before starting.
- **Wrong account or gateway:** rerun `npm run setup:local`; both IDs must belong to the same account.
- **Port already used:** Vite prints an available port. Use that exact origin; writes and source imports enforce same origin.
- **Conversation URL:** regex validation accepts ChatGPT nonempty route paths, including `/s/<id>`, Claude `/share/<id>`, and Claude `/code/session_<id>`. Only exact HTTPS vendor domains are allowed; credentials, query parameters, fragments, encoded paths and dot segments are rejected. Matching the pattern does not establish public readability.
- **Shared link or Code session restricted, blocked, dynamic or changed:** use chat-history JSON or labelled conversation paste. Attach omitted artifacts separately. Provider login cookies are never imported.
- **Binary artifact URL:** download it and add the file. URL intake accepts public text/code/HTML only, not private networks.
- **PDF has no readable text:** scanned pages need OCR beforehand. Extraction does not establish visual layout or behavior.
- **Clef switch unavailable:** complete local Workers AI/Gateway setup, then restart once to load the bindings. Connection setup is separate from choosing whether to use AI.
- **AI quota exhausted:** evidence remains; wait or turn Clef off in Settings. Failed inference is never represented as fixture CLEF output.
- **Case expired:** records expire after 24 hours. Save a report if needed; it contains supplied evidence and should be stored privately.

Stop the service with Ctrl+C. To reset the emulator, stop it and remove only this project's `.wrangler` directory, which removes local cases and sessions. Do not upload it to GitHub.

## Optional deployment

Demo/staging commands are retained for advanced use. Public deployment requires R2, Turnstile and signing secrets supplied through **Workers & Pages → Worker → Settings → Variables and Secrets**, or Wrangler's protected `secret put` prompt. The helper refuses to deploy the local configuration. Shared-link fetching is a local Vite service and is unavailable in a deployed Worker.

The [OAuth installer prototype](INSTALLER-LEGACY.md) has separate operator prerequisites and is outside the local setup promise.

Sources: [Wrangler login](https://developers.cloudflare.com/workers/wrangler/commands/#login), [remote bindings](https://developers.cloudflare.com/workers/development-testing/bindings-per-env/), [AI Gateway](https://developers.cloudflare.com/ai-gateway/), [Workers AI](https://developers.cloudflare.com/workers-ai/).
