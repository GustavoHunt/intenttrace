# API contract

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
