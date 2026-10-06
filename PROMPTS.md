# AI assistance disclosure

IntentTrace is being implemented with OpenAI Codex. The author selected the product direction, experience, scope and hosting constraints. AI assistance is disclosed so reviewers can distinguish the applicant's decisions from generated implementation work.

## User prompts preserved verbatim

> Suggest something based on my experience so it's unique to me, and we don't run the risk of the other candidates asking ChatGPT for ideas and you building the same thing for multiple people. Maybe something related to my work at Business Forensics or ScopeWorth. Here's the CV I will use it

The CV and personal file path are deliberately excluded from this public repository.

> Plan the IntentTrace implementation; it will be hosted in a public GitHub repo, so no hardcoded API keys or secrets. Include setup instructions that ask the user to provide the necessary credentials through the respective Cloudflare service. Research what other services from Cloudflare we can leverage to build this [https://developers.cloudflare.com/agents/?utm_content=agents.cloudflare.com](https://developers.cloudflare.com/agents/?utm_content=agents.cloudflare.com)

> Implement the proposed plan.

## Planning decisions

The following is a summary, not a verbatim prompt transcript: anonymous isolated public sandbox; bounded working demonstration and JSON evidence imports; React and TypeScript; mockups before interface implementation; a software scope-change scenario; modest paid hosting; chronological case-file interface. The working demonstration uses synthetic tasks and an allowlisted export configuration rather than arbitrary repository edits.

## Generated assets

The exact image-generation prompts are stored beside the three mockups in `.impeccable/mocks/*.png.json`. Unapproved mockups are design alternatives, not screenshots of a working product. Their illustrative labels are not claims about real customers, owners, or investigations.

## Implementation record

- Implemented schema validation, immutable scope references, export evidence and deterministic checks.
- Implemented Cloudflare Agent persistence, authenticated routing, background investigation, private artifacts and model-call reservations.
- Added unit and local runtime integration tests, synthetic import examples and setup documentation.
- Corrected limits and storage after local runtime testing; the app uses a SQLite table for larger case records.

The model-facing runtime prompts are checked in as source in `src/server/ai.ts` and `src/server/index.ts`. They are separate from these coding instructions.

This file is a curated record of the supplied task prompts and implementation decisions, not a complete transcript of every tool call. Private credentials, personal documents and hidden system instructions are excluded. The final submission should link this file and disclose any further AI assistance.
