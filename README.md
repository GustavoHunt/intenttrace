# IntentTrace

Did the AI deliver what you asked for? Import the conversation, add the delivered artifact, review its requirements, and inspect the evidence behind each assessment.

IntentTrace connects intent to delivery through an investigation case file. It is inspired by Gustavo's work in business forensics and software scope management. This repository contains synthetic examples, with no employer records, customer data, CV details, private transcripts or credentials.

**Download and run locally.** The opening screen asks for a ChatGPT or Claude shared conversation link. You can also import chat-history JSON, paste a labelled conversation, or start with just the original prompt and an artifact. No hosted OAuth installer is required.

## Quick start

Use Node.js **22.13 or newer** and npm. Download with **Code → Download ZIP**, extract it, and open a terminal in the directory containing `package.json`. Or clone this repository.

```sh
npm ci
npm run dev:offline
```

Open the localhost address printed in the terminal, normally `http://127.0.0.1:5173`. Offline mode exercises intake, case memory, chat and the CSV verifier without credentials. **It does not call an LLM or CLEF.** General requirements remain insufficient evidence until assessed in live mode.

## Enable live Llama + CLEF

1. Sign in through Cloudflare's own browser login: `npx wrangler login`. Wrangler stores the login in its private local configuration; never paste credentials into source files or chat.
2. In your Cloudflare dashboard, copy the intended account's **Account ID**. In **AI → AI Gateway**, create a gateway in that account and copy its **Gateway ID**. Disable persistent prompt/response logging and caching. Workers AI uses your login and native binding; no external LLM key is needed.
3. Run setup, which asks only for those two public resource identifiers:

```sh
npm run setup:local
npm run dev:live
```

Setup writes an ignored local configuration. R2, Durable Objects and Workflows run in Cloudflare's local emulator; only AI calls use your account. This path requires no deployed Worker, R2 activation, Turnstile widget or OAuth client. Live calls use account quota and can incur charges. The app reserves calls before inference (30 per session, 200 per day by default); these limits do not cap your entire Cloudflare bill.

If login expires, run `npx wrangler whoami`, then retry. See [setup and troubleshooting](docs/INSTALLATION.md).

## Investigate a conversation

1. Paste a public `https://chatgpt.com/share/…` or `https://claude.ai/share/…` link and choose **Read shared conversation**. Review the imported prompt. Shared snapshots can omit attachments.
2. Add the delivered artifact as a file, public HTTPS text/code/HTML URL, or pasted text. Files include text, code, CSV, JSON, Markdown, PDF and DOCX. PDF/DOCX assessment covers extracted text, not layout, images or behavior.
3. Create the case. In live mode Llama proposes requirements; edit them to one testable requirement per line and **Confirm requirements**. Extraction failure preserves the prompt for manual review.
4. Choose **Assess with CLEF**. A Workflow snapshots evidence, calls the actual `@cf/cloudflare/clef` decision model, retains probabilities, and asks Llama to explain the findings. Inspect linked evidence or ask the persistent investigation chat a question.

CLEF is a model assessment, not proof. A supported/contradicted result needs a top probability of at least 75% and a margin of at least 20 percentage points; otherwise IntentTrace reports insufficient evidence. These are application thresholds, not calibrated accuracy guarantees. Missing artifacts also yield insufficient evidence, irrespective of conversation claims. No arbitrary code, page script or repository is executed.

ChatGPT and Claude have no documented stable public import API. IntentTrace conservatively reads visible messages or embedded JSON without account cookies. Restricted links, bot protection or changed formats can make imports unavailable; it never invents history or bypasses access controls. Use JSON export or labelled `User:` / `Assistant:` text instead. A multi-conversation export lets you select one conversation before case storage. Large exports should first be reduced to the intended conversation.

Try [the synthetic conversation](examples/conversation.json) with [its Markdown artifact](examples/release-summary.md) for general intake. **Open CSV example** offers a deterministic demonstration: 18 approved open tasks versus 24 total tasks, with correct delivery, scope divergence, or missing evidence. A later approval never retroactively authorizes an earlier run.

## Cloudflare components

| Component | Role |
| --- | --- |
| Workers AI / Llama 3.3 | Draft requirements, bounded export configuration, explanations and grounded chat. |
| Workers AI / CLEF | Typed requirement decisions and probabilities against supplied artifact text. |
| Agents / Durable Objects | Case coordination, SQLite state, persisted chat, ownership and call budgets. |
| Workflows | Immutable snapshots, assessment, explanation and revision publication. |
| R2 | Private artifact contents and SHA-256 integrity checks, emulated locally. |
| AI Gateway | Native model routing; requests disable content collection and caching. |
| Workers + Static Assets | Same-origin React case desk and API, served locally by Vite. |
| Turnstile / Workers Secrets | Optional public deployment protections; unnecessary for localhost. |

Cases expire after 24 hours and can be deleted from the desk. Local persistence is under ignored `.wrangler`; downloaded reports remain on your computer. In live mode selected prompts/artifacts go to Cloudflare for inference. Review the provider's data terms before importing confidential material. A hash establishes byte integrity after receipt, not authenticity.

## Development and validation

```sh
npm run check
npm test
npm run test:e2e
npm run build
npm run scan:secrets
```

The integration suite uses local Workflows, Durable Objects, R2 and Agent chat; its model responses are explicitly offline. Live CLEF and Llama were separately validated on synthetic material through the local app. See [validation](docs/VALIDATION.md), [architecture](docs/ARCHITECTURE.md), [API](docs/API.md), [security](SECURITY.md), and [AI-assisted development disclosure](PROMPTS.md).

Public deployment is optional. [The retained installer prototype](docs/INSTALLER-LEGACY.md) is an advanced experiment, not required for the downloadable app. Never commit `.dev.vars`, `.env`, `.wrangler`, `.local`, generated account configuration, exported browser state, credentials or private evidence.

Primary documentation: [Cloudflare Agents](https://developers.cloudflare.com/agents/), [CLEF model API](https://developers.cloudflare.com/workers-ai/models/clef/), [CLEF decision model design](https://blog.cloudflare.com/clef-decision-models/), [ChatGPT shared links](https://help.openai.com/en/articles/7925741-sharing-conversations-and-scheduled-tasks-in-chatgpt), [Claude shared chats](https://support.claude.com/en/articles/16762437-public-links-for-shared-chats).
