# AI assistance disclosure

IntentTrace is being implemented with OpenAI Codex. The author selected the product direction, experience, scope and hosting constraints. AI assistance is disclosed so reviewers can distinguish the applicant's decisions from generated implementation work.

## User prompts preserved verbatim

> Suggest something based on my experience so it's unique to me, and we don't run the risk of the other candidates asking ChatGPT for ideas and you building the same thing for multiple people. Maybe something related to my work at Business Forensics or ScopeWorth. Here's the CV I will use it

The CV and personal file path are deliberately excluded from this public repository.

> Plan the IntentTrace implementation; it will be hosted in a public GitHub repo, so no hardcoded API keys or secrets. Include setup instructions that ask the user to provide the necessary credentials through the respective Cloudflare service. Research what other services from Cloudflare we can leverage to build this [https://developers.cloudflare.com/agents/?utm_content=agents.cloudflare.com](https://developers.cloudflare.com/agents/?utm_content=agents.cloudflare.com)

> Implement the proposed plan.

> Let's go with A. Research how we can incorporate Cloudflare CLEF into our demo: [https://blog.cloudflare.com/clef-decision-models/](https://blog.cloudflare.com/clef-decision-models/)

> For the Cases, research if we can import the user's chat history and their artifacts so we can run the verification, making super easy for users to test. A fallback would be to start the chat asking for an artifact or a URL and the original prompt, 2 simple things to kick start

> Research how we can make the setup as easy as possible, can we with 1 click request access to the user's Cloudflare account and create all the resources this demo needs?

The subsequent implementation request authorized personal account testing. Account identifiers, consent records, tokens and contact details are excluded. The latest direction replaces the primary hosted installer with a downloadable local app and completes actual CLEF plus general intake.

> Let's keep this as a downloadable app from Github and it can run locally based on the instructions. Finish up CLEF integration, general chat-history/artifact intake and change the initial demo to be a ChatGPT or Claude shared link that the user needs to input, offer the CSV options as a suggestion

## Planning decisions

The subsequent URL-validation request asked for regex assertions accepting both vendors, specifically Claude `https://claude.ai/code/session_${X}` and ChatGPT `https://chatgpt.com/${X}`. The implementation shares complete-URL regexes across the form, intake schema and local fetcher, preserves exact-host/HTTPS restrictions, and distinguishes accepted format from public readability. Browser access is not expanded and no login cookies are forwarded.

The follow-up requested ChatGPT `https://chatgpt.com/s/${id}`. The existing multi-segment regex already accepts that route; explicit regression tests cover it with and without a trailing slash, and setup documentation lists it as a supported format.

The following is a summary, not a verbatim prompt transcript: anonymous isolated public sandbox; bounded working demonstration and JSON evidence imports; React and TypeScript; mockups before interface implementation; a software scope-change scenario; modest paid hosting; chronological case-file interface. The working demonstration uses synthetic tasks and an allowlisted export configuration rather than arbitrary repository edits.

## Generated assets

The exact image-generation prompts are stored beside the three mockups in `.impeccable/mocks/*.png.json`. Unapproved mockups are design alternatives, not screenshots of a working product. Their illustrative labels are not claims about real customers, owners, or investigations.

## Implementation record

- Implemented schema validation, immutable scope references, export evidence and deterministic checks.
- Implemented Cloudflare Agent persistence, authenticated routing, background investigation, private artifacts and model-call reservations.
- Added unit and local runtime integration tests, synthetic import examples and setup documentation.
- Corrected limits and storage after local runtime testing; the app uses a SQLite table for larger case records.
- Implemented approved case-desk option A, streamed chat, evidence import/download, scope confirmation and scenario execution.
- Implemented the separate OAuth installer with PKCE, encrypted temporary credentials, resumable Cloudflare provisioning, checksummed release packaging, and owner-authenticated live service checks.
- Actual local Cloudflare runtime testing found unsupported `redirect: error`, an illegal native-fetch receiver, and forwarded request-stream lifetime errors. Replaced them with manual redirect rejection, an unbound fetch call, and bounded body materialization; added regression coverage.
- Live account validation exposed an OAuth scope mismatch: Workers Editor did not authorize static asset upload; Cloudflare documents Workers Scripts Write. The installer now requests that exact scope and preserves resources during reconnection.

The model-facing runtime prompts are checked in as source in `src/server/ai.ts` and `src/server/index.ts`. They are separate from these coding instructions.

This file is a curated record of the supplied task prompts and implementation decisions, not a complete transcript of every tool call. Private credentials, personal documents and hidden system instructions are excluded. The final submission should link this file and disclose any further AI assistance.

### Live validation and release recovery

The user requested a happy path that opens Timeline, a guided tour showing requirement confirmation and Clef assessment, and a runtime application setting replacing the offline environment toggle. Implementation uses a skippable/replayable guide around real controls, server-persisted per-session Clef/AI settings, and a captured mode for each Workflow. Live validation used only a synthetic request/artifact in the previously authorized Cloudflare account. Unrelated local importer changes were preserved separately.

The corrected deployment scope was authorized by the user. Real installation then exposed a Workers AI response shape difference: the response can already be a structured object rather than JSON text. Both shapes now pass the same schema validation. Failed installation model checks can recover with a bounded new operation; normal lost-response retries preserve the original operation identity. Application updates require an explicit update operation and record their previous release hash.

Owner maintenance after grant revocation uses an existing authorized local Cloudflare login and retains secrets in Cloudflare. Later local validation used a synthetic release-summary conversation/artifact with actual Llama drafting and CLEF probability decisions. General intake accepts public share links, supported JSON exports, labelled text, original prompt plus files/URL/pasted artifact text. The local source fetcher validates and pins public DNS addresses, and never forwards login cookies. Requirements require explicit review; model assessments are distinct from deterministic CSV checks. Implementation assistance added bounded PDF/DOCX text extraction, pending-upload safeguards and explicit probability thresholds. Runtime prompts are in `src/server/clef.ts` and `src/server/intake-case.ts` as well as the earlier model modules.
