# API contract

## Application settings

Authenticated `GET /api/settings` returns `{clefEnabled, aiAvailable, mode}`. Same-origin `POST /api/settings` accepts only `{clefEnabled: boolean}` and saves it in the session registry. Sessions default to off; enabling without Workers AI and AI Gateway returns 503. Settings are isolated per session, retained through refresh, and expire with the 24-hour session. The environment selects service bindings, never offline/live mode.

Intake and chat capture the session choice per request. A Workflow captures `modelMode` at dispatch and uses it for both Clef and the Llama explanation, including retries. Later setting changes do not alter an in-flight assessment or relabel existing findings. Deployment signing and Turnstile enforcement are independent of the AI setting.

## General intake

| Route | Behavior |
| --- | --- |
| POST `/local/source` | Local Vite only. Same-origin `{url, kind: "conversation" or "artifact"}`. Public HTTPS/DNS-pinned fetch, 1 MiB response cap, text-only artifact URLs. Returns preview, no case creation. |
| POST `/api/intake` | Authenticated `{title, provider, sourceUrl?, messages, originalPrompt, documents, warnings?}`. Validated supplied history and artifacts, unapproved draft requirements. 1 MiB request cap. |
| POST `/api/cases/:id/requirements` | `{requirements: [{id: "req_1", text: "..."}]}` confirms a scope version. 1–12 unique IDs; 3–1,000 characters per requirement. |
| POST `/api/cases/:id/documents` | `{documents: [{name, content, mediaType?, originalSha256?}]}` adds artifact text and supersedes findings. Eight per request; 30 artifacts per general case. |
| POST `/api/cases/:id/investigate` | `{}` for general cases. Requires confirmed requirements. Publishes `method`, `scopeId`, CLEF `decision` probabilities and findings. |

Messages contain `{id, role: "user" or "assistant", text}`; up to 150 messages of at most 60,000 characters, subject to total byte limits. Documents allow 300,000 extracted characters each. General reports contain intake metadata and evidence text, and are not directly reusable legacy bundles. General cases cannot invoke the CSV executor. Findings are model assessments, not deterministic proof.

Llama context is bounded to 16 KiB per call. CLEF input is capped at 60,000 encoded bytes including questions; excerpts disclose truncation. Local development skips Turnstile only with the localhost restriction and a generated persisted signing key.

## Common routes and CSV evidence bundles

All routes are same-origin. Session cookies are HttpOnly. POST bodies use `application/json`. Errors return a public `error` string without source contents or credentials.

| Method / route                             | Purpose                                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| GET `/api/config`                          | Public mode, Turnstile sitekey and model identifier.                                                     |
| POST `/api/session`                        | `{token}` from Turnstile; token optional in local offline mode. Creates a signed 24-hour session cookie. |
| GET `/api/cases`                           | Owning session's case summaries and expiry.                                                              |
| POST `/api/cases`                          | `{scenario: "correct" \| "divergence" \| "missing"}` creates a synthetic case.                           |
| POST `/api/import`                         | Validated evidence bundle creates a supplied-evidence case.                                              |
| GET `/api/cases/:id`                       | Case state and artifact metadata.                                                                        |
| DELETE `/api/cases/:id`                    | Deletes case data, chat and artifacts; closes connections.                                               |
| POST `/api/cases/:id/scope`                | `{selection: "filtered" \| "project"}` confirms scope or creates a new version.                          |
| POST `/api/cases/:id/run`                  | `{operationId: UUID}` reserves and executes a bounded run, then starts investigation.                    |
| POST `/api/cases/:id/investigate`          | `{runId?: UUID}` starts investigation of a selected or latest run.                                       |
| POST `/api/cases/:id/evidence`             | Appends an evidence bundle without overwriting existing records.                                         |
| GET `/api/cases/:id/artifacts/:artifactId` | Integrity-checked private artifact. Add `?format=csv` for an export.                                     |
| GET `/api/cases/:id/report`                | Downloadable JSON report, including source evidence and finding revisions.                               |
| `/agents/case-agent/:sessionId_:caseId`    | Cloudflare Agent chat/state protocol, checked against session ownership before routing.                  |

Limits: five cases per session, 30 runs per case, 500 events, 100 artifacts, 30 scope versions, 1 MiB per upload and 2 MiB total case state. Chat questions are limited to 2,000 characters and 100 persisted messages. Model context is bounded to 16 KB per request. Import limits are structural and byte-based; unsupported evidence is reported as insufficient rather than treated as proof.


## Evidence configuration

- `GET /api/connections`: current session connection metadata only; never returns credentials.
- `POST /api/connections`: strict provider-specific connection input. Saves an encrypted credential, returning metadata; collection verifies access later.
- `DELETE /api/connections/:id`: disconnect a session credential for future reads.
- `POST /api/cases/:id/evidence-plan`: save bounded coverage, environment/URL targets, selected connection IDs, freshness, optional exact commit and analytics dates, and requirement-linked checks. Rejects active investigations, noncurrent requirement IDs and unavailable connection IDs; supersedes prior findings.
- `POST /api/evaluations/:fixtureId`: live Llama/CLEF assessment of a built-in synthetic fixture only; requires live AI enabled and normal rate/budget availability. No arbitrary evidence, URLs or credentials accepted.

All routes use existing session ownership and same-origin mutation rules. Reports include the saved evidence plan, source provenance, check results, limitations and unvisited discovered URLs. Reports never contain connection credentials.
