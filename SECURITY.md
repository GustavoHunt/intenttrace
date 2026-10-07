# Security boundaries

This public repository must contain only synthetic evidence and public identifiers. User imports stay in ignored local runtime storage. Live mode sends selected evidence to Cloudflare Workers AI; review the provider's terms before processing confidential material. Never commit real client documents, tokens, private source or chat transcripts.

- Production credentials belong in Cloudflare Workers Secrets. Workers AI and R2 are accessed through bindings, not embedded API keys.
- Local `.dev.vars`, `.env`, generated deployment configuration, Wrangler state and dependency directories are ignored by Git.
- The included scanner flags common credential patterns without printing suspected values. It cannot detect every secret. Review staged changes before publication and enable GitHub secret scanning/push protection where available.
- Server ownership checks protect both HTTP case routes and the Agent protocol. Turnstile does not replace ownership checks.
- Imported evidence and model text are untrusted. No imported string is executed or allowed to expand the tool allowlist. Explicit public URLs are fetched only by the local Vite importer: HTTPS, bounded response sizes, DNS answers validated and pinned for each redirect, no credentials/cookies, blocked private/special IPs. HTML is parsed as data and displayed as text; scripts never execute.
- Local development requires localhost and the server binds to 127.0.0.1. A random local signing key replaces the public Turnstile/secret setup. Never expose this configuration through a public proxy or tunnel.
- File import limits are 5 MiB and 300,000 extracted text characters; PDFs are limited to 80 pages. DOCX extraction includes document text, not macros, embedded objects or images. Original binary and extracted-text hashes describe different bytes. CLEF receives bounded excerpts; omitted material remains unknown.
- Hash validation detects changed bytes. It does not establish the author, provenance or accuracy of imported evidence.
- The application disables AI Gateway content logging per request and logs operation metadata only. Cloudflare service telemetry and retention still need an operator review before handling anything beyond synthetic data.
- Model quotas are atomic reservations. Request-rate limits are an additional abuse control and are not an account-wide bill cap.
- The OAuth installer requests account-level scopes; installation-name restrictions are enforced by application code. Its AES-GCM credential vault has a 30-minute lifetime, single-use OAuth state, PKCE, same-origin writes and a request limit. It revokes access on successful completion or explicit disconnect; expiration attempts provider revocation before deleting its local copy. A provider outage can prevent confirmed revocation.
- The installer does not log raw requests. Use warning-level local development logs so callback URLs containing authorization codes are not printed. Do not enable request logging or analytics on OAuth callback routes without redaction.
- `/api/install-check` requires the installed application's generated signing secret and only renders fixed synthetic HTML. It accepts no URL or arbitrary program. Its result is cached in private R2 and scoped to the packaged release.
- Operator-only scope repair accepts an administration token through an environment variable or a local ignored file, never a command-line token value. Revoke the temporary OAuth Client Write token after configuring the client.

If a credential is ever exposed, revoke/rotate it in its issuing service first; deleting a file or rewriting Git history does not revoke access. Do not paste suspected credentials into a public issue. This project does not promise a staffed security response service.
