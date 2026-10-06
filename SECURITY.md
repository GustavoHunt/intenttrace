# Security boundaries

This repository must contain only synthetic evidence and public identifiers. Never submit real client documents, tokens, private source code, or confidential chat transcripts to the hosted sandbox.

- Production credentials belong in Cloudflare Workers Secrets. Workers AI and R2 are accessed through bindings, not embedded API keys.
- Local `.dev.vars`, `.env`, generated deployment configuration, Wrangler state and dependency directories are ignored by Git.
- The included scanner flags common credential patterns without printing suspected values. It cannot detect every secret. Review staged changes before publication and enable GitHub secret scanning/push protection where available.
- Server ownership checks protect both HTTP case routes and the Agent protocol. Turnstile does not replace ownership checks.
- Imported evidence and model text are untrusted. No imported string is executed, interpreted as HTML, fetched as a URL, or allowed to expand the tool allowlist.
- Hash validation detects changed bytes. It does not establish the author, provenance or accuracy of imported evidence.
- The application disables AI Gateway content logging per request and logs operation metadata only. Cloudflare service telemetry and retention still need an operator review before handling anything beyond synthetic data.
- Model quotas are atomic reservations. Request-rate limits are an additional abuse control and are not an account-wide bill cap.

If a credential is ever exposed, revoke/rotate it in its issuing service first; deleting a file or rewriting Git history does not revoke access. Do not paste suspected credentials into a public issue. This project does not promise a staffed security response service.
