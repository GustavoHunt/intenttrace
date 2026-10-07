# Validation evidence

## Local checks on 7 October 2026

- TypeScript check passed.
- 73 unit tests passed, including shared vendor regex validation for Claude Code sessions and generic ChatGPT routes, malformed/lookalike URLs, conversation branches, Claude blocks, share payloads, prototype-pollution rejection, DNS pinning/redirect/size boundaries, CLEF probability thresholds and schemas, plus prior runtime/installer coverage.
- Eight integration tests passed against local Workflows, Durable Objects, R2 and Agent chat. They include general intake, explicit requirement approval, artifact preservation, superseded findings, and local source restrictions. Model calls in these tests are explicitly offline.
- Application build passed. A frontend chunk-size advisory remains (approximately 161 kB compressed); PDF parsing and its worker are lazy-loaded.
- Dependency audit reports zero known vulnerabilities after replacing a vulnerable DOCX dependency with bounded XML text extraction.
- Public-file secret-pattern scan passed. It is a heuristic, not a proof of absence.

## Live Cloudflare evidence

The private local OAuth installer completed account discovery and provisioned uniquely named resources in the authorized personal account: private R2 with one-day expiration, authenticated AI Gateway with prompt logging disabled, managed Turnstile, the Worker, three Durable Object classes and an investigation Workflow. Existing applications were not modified.

All six owner-authenticated installation checks passed: storage, memory, workflow, Workers AI, AI Gateway and Browser Run. This was live inference, not fixtures. The successful installation revoked the temporary OAuth grant and cleared its credential vault. The completed receipt is retained only in ignored local validation files.

The separate temporary OAuth administration token used to repair Workers Scripts Write was also revoked; a subsequent API request returned 401. The dashboard had initially offered Workers Editor, which was insufficient for asset upload. The documented repair script verifies the exact registered scopes.

After initial installation, the case desk update was deployed using the owner's existing local Wrangler login, retaining secrets in Cloudflare. Its subsequent browser validation confirmed:

- Managed Turnstile established a real session.
- A synthetic scope was confirmed and a live demonstration executed.
- The workflow detected 24 exported tasks versus 18 approved tasks, with internal notes excluded and source state unchanged.
- Live investigation chat explained the divergence and displayed clickable evidence references.
- Case and chat history survived a browser refresh.
- Comparison and dashboard controls opened their respective views.
- Desktop and readable 390-pixel mobile top/chat captures were inspected. Document width matched the mobile viewport.

The six installation checks belong to the initial verified release. Later UI updates have separate deployment receipts and browser evidence; they do not retroactively change that installation receipt.

## Scope and remaining milestones

The latest primary delivery is a GitHub download running on localhost. Real Workers AI calls were validated through the remote binding in that local app, with R2/Durable Objects/Workflows emulated. A synthetic release-summary conversation and Markdown artifact produced live Llama requirement drafts and actual CLEF decisions: 89.03% support for a heading, 95.81% for three bullet points, and 85.45% for exclusion of internal notes. These probabilities are model outputs, not measured accuracy. CLEF duration was approximately half a second; Llama explanation ran separately. The synthetic run receipt is kept only in ignored local validation storage.

General intake implements supported ChatGPT/Claude JSON export formats, labelled conversation paste, manual original prompt, text/code/CSV/JSON/PDF/DOCX files, pasted artifact text and public artifact URLs. Shared-page parsing is tested against synthetic JSON, flattened graph and DOM payloads. A successful import from an actual current provider-hosted share link has not been claimed: formats and access restrictions can change. Blocked or unreadable links have an explicit export/paste fallback.

The changed opening intake was inspected at desktop and 390×844 mobile, with document width matching the viewport. Browser validation created a case from pasted synthetic conversation and artifact, reviewed Llama's drafts, invoked real CLEF, navigated the supplied conversation, asked a live investigation question, and verified case/chat persistence after refresh. The automation browser's file upload permission was unavailable; PDF/DOCX extraction is implemented and build-checked but not represented as an end-to-end browser upload validation.

The optional installer remains a retained prototype. A public OAuth client/hosted installer is no longer part of the requested primary delivery.

The Impeccable review's functional fixes were implemented and sent back for a scoped verdict. The legacy comp/spec phase ledger has not been represented as passed. Final review disposition is recorded separately when available.

Credentials, private local state and account screenshots remain excluded from public source. Publication and exact-head CI are recorded separately after they occur.

## Final scoped UI review

The latest scoped Impeccable verdict is **ship** for the changed intake: desktop/mobile layout, artifact-pending safeguards, requirement validation and product documentation are resolved. This covers those scored changes, not universal shared-provider compatibility or every expanded/error state. The earlier review's hosted installer requirements are outside the user's revised local-delivery scope. The approved A comp is recorded; the legacy measured phase ledger is not represented as fully passed.

The skill's shipped reviewer/documenter instructions were followed by ordinary delegated agents because this harness has no named Impeccable agent type. DESIGN.md and its design-token sidecar describe the final implemented surface.
