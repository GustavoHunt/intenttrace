# IntentTrace

Did an AI agent deliver the change you approved—and what evidence supports that conclusion?

IntentTrace follows a software change from intent, through an approved scope, to execution and evidence. Its demonstration asks an agent to configure CSV export for a synthetic project. A deterministic verifier compares the actual export with the scope version approved before that run. An LLM explains the findings and answers questions through a persistent case conversation.

Inspired by work connecting software delivery to business scope and by evidence-based investigation. No employer records, customer data, CV details, or proprietary source code are included.

**Implementation status:** backend and local runtime tests are implemented. The interface is awaiting selection of a supplied mockup. Public hosting and live model acceptance are pending. Local offline tests do not establish live AI functionality.

## The demonstration

The request is: “Add CSV export for the currently filtered tasks in this project. Exclude internal notes and leave task data unchanged.”

Project Atlas contains 24 synthetic tasks, of which 18 are open. The approved filtered selection includes those 18 tasks. Three scenarios exercise the same execution and verification paths:

| Scenario          | Result                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| Correct execution | The export contains the approved tasks, omits notes, and preserves task state.                     |
| Scope divergence  | An explicitly injected adapter fault broadens selection to all 24 tasks. The mismatch is detected. |
| Missing evidence  | The result artifact is deliberately withheld. The verifier reports insufficient evidence.          |

A later approval to export all project tasks creates a new scope version. It does not retroactively authorize an earlier run. Imported evidence is marked **supplied**, because content hashes establish integrity, not truth or authenticity.

## Cloudflare components

| Requirement      | Implementation                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| LLM              | Workers AI, default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, through an AI binding.                                                    |
| Coordination     | A Cloudflare Workflow snapshots evidence, verifies scope, explains findings, and publishes a revision.                                    |
| Chat             | React client planned; the server uses Cloudflare `AIChatAgent` and persistent message history.                                            |
| Memory           | A case Agent Durable Object stores case state in SQLite and conversation history in SDK-managed storage.                                  |
| Evidence         | Private R2 artifacts with SHA-256 hashes; downloads require the owning session.                                                           |
| Model visibility | AI Gateway; request/response collection is disabled in code. Worker logs record model operation duration and token counts where supplied. |
| Public sandbox   | Turnstile, signed HttpOnly cookies, same-origin writes, 24-hour sessions, and ownership checks.                                           |
| Spend control    | Durable Object counters reserve model calls before inference: 30 per session and 200 per day by default.                                  |

Workers Static Assets hosts the React build beside the API; a separate Pages project is unnecessary. See [architecture](docs/ARCHITECTURE.md) for tradeoffs and deferred services.

## Local development

Use Node.js 22.12 or newer and npm. From the repository root:

```sh
npm ci
npm run check
npm test
npm run dev:offline
```

The local service listens on `http://127.0.0.1:5173`. Offline mode is limited to localhost and **does not call an LLM**. Configuration and explanations use deterministic fixtures and are explicitly labelled offline. It requires no Cloudflare credentials.

```sh
npm run test:e2e
npm run scan:secrets
```

The current integration suite exercises real local Workflows, Durable Objects and R2 through HTTP. Once browser tests are added, install Chromium with `npx playwright install chromium`.

## Deploy your own instance

All resources must belong to your selected Cloudflare account. Use separate `staging` and `demo` resource sets. Resource creation and inference can incur charges; check your account's current plan and pricing. The application counters limit AI calls, not your entire Cloudflare bill.

1. Authenticate with Cloudflare using `npx wrangler login`. Choose the account in the Cloudflare dashboard and copy its **Account ID**. Do not place an API token in a source file. For CI deployment, store a narrowly scoped Cloudflare token in GitHub environment secrets; deployment is deliberately manual in the included CI workflow.
2. In **AI → AI Gateway**, create a gateway in that account. Copy its Gateway ID, turn off persistent prompt/response logging, and leave caching disabled for this evidence workflow. The Workers AI binding supplies account identity; no external LLM key or AI Gateway token is required by this application.
3. In **Turnstile**, create a managed widget. Add your exact deployment hostname, such as `intenttrace-demo.<your-workers-subdomain>.workers.dev`. Copy the **sitekey** for public configuration. Keep its **secret key** in Cloudflare Workers Secrets. Add the staging hostname to a separate staging widget. Do not use the always-pass test keys on a public deployment.
4. In **R2**, enable the service if necessary. Run the following commands for the desired environment. `configure` asks only for the Account ID, Gateway ID, and public Turnstile sitekey. Its generated configuration is ignored by Git.

```sh
npm run setup -- configure staging
npm run setup -- resources staging
npm run setup -- secrets staging
npm run deploy:staging
```

`resources` creates a private evidence bucket and adds a one-day expiration rule. If the bucket already exists, confirm its ownership in R2 and add the lifecycle rule there; do not delete existing data to rerun setup. The Worker deployment creates the Agent bindings and Workflow from the configuration.

`secrets` uses Wrangler's protected prompt to upload `TURNSTILE_SECRET_KEY` directly to Workers Secrets, then generates a random `SESSION_SIGNING_SECRET` and uploads it without writing it to disk or printing it. Wrangler may offer to create the named Worker before its first deployment. You can alternatively add both secrets in **Workers & Pages → your Worker → Settings → Variables and Secrets**, with type **Secret**. Use a cryptographically random signing secret of at least 32 bytes. Rotating it ends existing sessions.

After staging is verified, repeat with `demo`:

```sh
npm run setup -- configure demo
npm run setup -- resources demo
npm run setup -- secrets demo
npm run deploy:demo
```

Visit the deployed hostname, complete Turnstile, and exercise all three scenarios and a chat question. Check the result labels show live model operation. A model outage can leave deterministic findings available while the explanation is labelled unavailable. Do not present that as a successful live LLM test.

### Optional live local development

Create the ignored live configuration as above. Copy `.dev.vars.example` to `.dev.vars` and put local development values there, obtained from Cloudflare Turnstile and a fresh random session secret. Add `127.0.0.1` to a development widget's allowed hostnames. Run `npm run dev:live`. This invokes real Workers AI and consumes quota. Never commit `.dev.vars`, `.env`, Wrangler credentials, generated deployment files, or tokens. Real deployment secrets are supplied through Workers Secrets, not the browser.

## Evidence imports

See [the JSON Schema](docs/evidence-bundle.schema.json) and [synthetic examples](examples). A bundle contains scopes, events, runs and artifacts. Each artifact's hash covers the exact UTF-8 bytes of its `content` string. The upload limit is 1 MiB; cases are capped at 2 MiB in storage. IDs and references must be valid and duplicate-free. An omitted result artifact is allowed so a case can represent missing evidence.

The reporting endpoint contains case metadata and findings in addition to the import fields. To re-import a report, extract the six schema fields: `schemaVersion`, `title`, `scopes`, `events`, `runs`, and `artifacts`. Additional evidence must use new record IDs and event sequence numbers; conflicting records are rejected.

## Verification and limits

The verifier checks the supported task-export format, not arbitrary software changes. There is no arbitrary code execution, external URL fetching, GitHub write access, or autonomous production change. The LLM can choose an allowlisted export configuration or a read-only investigation view. Findings remain deterministic even when model prose is wrong. Known citation IDs alone do not prove the prose is accurate; reviewers should inspect the linked evidence.

Sessions and case access expire after 24 hours. Durable Object alarms delete stored cases and messages, and R2 lifecycle expiration is a fallback for orphaned artifacts. Expiration is eventual; provider logs, Workflow history, and backups have independent retention. This is a public synthetic-data demonstration, not a confidential evidence repository or a compliance archive.

See [SECURITY.md](SECURITY.md), [the API contract](docs/API.md), and [PROMPTS.md](PROMPTS.md) for implementation boundaries and AI assistance disclosure.

## Documentation used

- [Cloudflare Agents](https://developers.cloudflare.com/agents/)
- [Chat Agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/)
- [Agent Workflows](https://developers.cloudflare.com/agents/concepts/workflows/)
- [Workers AI through AI Gateway](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)
- [Turnstile widget setup](https://developers.cloudflare.com/turnstile/get-started/widget-management/dashboard/)
- [R2 lifecycle commands](https://developers.cloudflare.com/workers/wrangler/commands/r2/)
