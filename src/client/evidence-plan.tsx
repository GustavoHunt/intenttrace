import React, { useEffect, useState } from "react";
import type { CaseView } from "../shared/domain";
import {
  defaultEvidencePlan,
  EvidencePlanSchema,
  type EvidencePlan,
  type ConnectionView,
  type AcceptanceCheckSchema,
} from "../shared/investigation";
import type { z } from "zod";

const kinds = {
  http: "HTTP response",
  text: "Visible text",
  canonical: "Canonical URL",
  no_js: "Content without JavaScript",
  faq: "FAQ answers match initial HTML",
  accordion: "Accordion opens and closes",
  hreflang: "Reciprocal language links",
  ci: "CI for the exact commit",
  analytics: "Recorded analytics event",
};
async function request(path: string, body?: unknown, method = "POST") {
  const response = await fetch(
    path,
    body === undefined
      ? undefined
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const value = (await response.json()) as any;
  if (!response.ok) throw new Error(value.error || "Request failed");
  return value;
}
export function EvidenceControls({
  data,
  busy,
  onSaved,
  onDirty,
}: {
  data: CaseView;
  busy: boolean;
  onSaved: (data: CaseView) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [plan, setPlan] = useState<EvidencePlan>(
    data.evidencePlan || defaultEvidencePlan(),
  );
  const [dirty, setDirty] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [connections, setConnections] = useState<ConnectionView[]>([]),
    [provider, setProvider] = useState("cloudflare_access");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [kind, setKind] = useState<keyof typeof kinds>("text"),
    [requirementId, setRequirement] = useState(
      data.scopes.at(-1)?.requirements?.[0]?.id || "req_1",
    ),
    [url, setUrl] = useState(""),
    [expected, setExpected] = useState("");
  const load = async () => {
    const result = await request("/api/connections");
    setConnections(result);
  };
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!dirty) setPlan(data.evidencePlan || defaultEvidencePlan());
  }, [JSON.stringify(data.evidencePlan)]);
  useEffect(() => {
    onDirty(dirty || pending);
    return () => onDirty(false);
  }, [dirty, pending]);
  function change(patch: Partial<EvidencePlan>) {
    setPlan((p) => ({ ...p, ...patch }));
    setDirty(true);
    setMessage("");
  }
  async function act(action: () => Promise<void>) {
    setPending(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  const field = (name: string, label: string, type = "text", hint?: string) => (
    <label>
      {label}
      <input
        type={type}
        value={fields[name] || ""}
        onChange={(e) => setFields({ ...fields, [name]: e.target.value })}
        autoComplete="off"
        required
      />
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
  return (
    <details className="evidence-controls">
      <summary>
        Evidence sources and checks{dirty ? " · Unsaved changes" : ""}
      </summary>
      <p>
        Choose where to look and what must be verified. Source content is
        treated as evidence, never as instructions.
      </p>
      <fieldset disabled={busy || pending}>
        <div className="evidence-grid">
          <label>
            Investigation depth
            <select
              value={plan.coverage}
              onChange={(e) =>
                change({ coverage: e.target.value as EvidencePlan["coverage"] })
              }
            >
              <option value="targeted">
                Targeted — up to 10 pages / 2 minutes
              </option>
              <option value="expanded">
                Expanded — up to 30 pages / 5 minutes
              </option>
            </select>
            <small className="muted">
              Expanded research uses more browser time and model calls. Provider
              limits still apply.
            </small>
          </label>
          <label>
            Expected environment
            <select
              value={plan.environment}
              onChange={(e) =>
                change({
                  environment: e.target.value as EvidencePlan["environment"],
                })
              }
            >
              <option value="unspecified">Not specified</option>
              <option value="staging">Staging</option>
              <option value="production">Production</option>
            </select>
          </label>
          <label className="evidence-wide">
            Target URLs · one per line
            <textarea
              rows={2}
              value={plan.targetUrls.join("\n")}
              onChange={(e) =>
                change({ targetUrls: e.target.value.split("\n") })
              }
              placeholder="https://staging.example.com"
            />
            <small className="muted">
              Evidence from other website origins cannot verify this
              environment. A hostname alone does not identify a release.
            </small>
          </label>
          <label>
            Maximum capture age · hours
            <input
              type="number"
              min={1}
              max={720}
              value={plan.maxAgeHours}
              onChange={(e) => change({ maxAgeHours: Number(e.target.value) })}
            />
          </label>
          <label>
            Expected commit · full SHA
            <input
              value={plan.expectedCommit}
              onChange={(e) =>
                change({ expectedCommit: e.target.value.trim() })
              }
              placeholder="Required for an exact-commit CI check"
            />
          </label>
          <label>
            Analytics start date
            <input
              type="date"
              value={plan.startDate || ""}
              onChange={(e) =>
                change({ startDate: e.target.value || undefined })
              }
            />
          </label>
          <label>
            Analytics end date
            <input
              type="date"
              value={plan.endDate || ""}
              onChange={(e) => change({ endDate: e.target.value || undefined })}
            />
          </label>
        </div>
        <h3>Private evidence connections</h3>
        <p className="small muted">
          Use existing read-only credentials. Secrets stay encrypted in this
          session, expire with it and are excluded from reports and model
          prompts. Connecting saves a credential; an assessment verifies whether
          it can read the source.
        </p>
        {connections.map((c) => (
          <div className="connection-row" key={c.id}>
            <label>
              <input
                type="checkbox"
                checked={plan.connectionIds.includes(c.id)}
                onChange={(e) =>
                  change({
                    connectionIds: e.target.checked
                      ? [...plan.connectionIds, c.id]
                      : plan.connectionIds.filter((id) => id !== c.id),
                  })
                }
              />
              {c.label} <small>{c.resource}</small>
            </label>
            <button
              type="button"
              onClick={() =>
                void act(async () => {
                  await request(`/api/connections/${c.id}`, {}, "DELETE");
                  change({
                    connectionIds: plan.connectionIds.filter(
                      (id) => id !== c.id,
                    ),
                  });
                  await load();
                })
              }
            >
              Disconnect
            </button>
          </div>
        ))}
        {!connections.length && (
          <p className="muted">
            No private sources connected. Public evidence remains available.
          </p>
        )}
        <details>
          <summary>Add a connection</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const c = await request("/api/connections", {
                  provider,
                  ...fields,
                });
                setFields(provider === "posthog" ? { region: "eu" } : {});
                change({ connectionIds: [...plan.connectionIds, c.id] });
                await load();
                setMessage(
                  "Credential saved. Save the evidence plan to use it in the next assessment.",
                );
              });
            }}
          >
            <div className="evidence-grid">
              <label>
                Provider
                <select
                  value={provider}
                  onChange={(e) => {
                    setProvider(e.target.value);
                    setFields(
                      e.target.value === "posthog" ? { region: "eu" } : {},
                    );
                  }}
                >
                  <option value="cloudflare_access">
                    Cloudflare Access · protected website
                  </option>
                  <option value="github">GitHub Actions · CI receipt</option>
                  <option value="posthog">PostHog · event counts</option>
                  <option value="search_console">
                    Google Search Console · search performance
                  </option>
                  <option value="ga4">Google Analytics 4 · event counts</option>
                </select>
              </label>
              {field("label", "Connection name")}
              {provider === "cloudflare_access" && (
                <>
                  {field(
                    "origin",
                    "Exact protected origin",
                    "url",
                    "For example https://staging.example.com — no path or trailing slash",
                  )}
                  {field("clientId", "Access service token ID")}
                </>
              )}
              {provider === "github" && (
                <>
                  {field("repository", "Repository · owner/name")}
                  {field("runId", "Workflow run ID")}
                </>
              )}
              {provider === "posthog" && (
                <>
                  <label>
                    Region
                    <select
                      value={fields.region || "eu"}
                      onChange={(e) =>
                        setFields({ ...fields, region: e.target.value })
                      }
                    >
                      <option value="eu">EU</option>
                      <option value="us">US</option>
                    </select>
                  </label>
                  {field("projectId", "Project ID")}
                  {field("site", "Website URL", "url")}
                </>
              )}
              {provider === "search_console" &&
                field(
                  "site",
                  "Verified property",
                  "text",
                  "Use sc-domain:example.com or the exact URL-prefix property.",
                )}
              {provider === "ga4" && field("propertyId", "GA4 property ID")}
              {field(
                "secret",
                provider === "cloudflare_access"
                  ? "Access service token secret"
                  : provider === "github"
                    ? "Token with Actions read access"
                    : provider === "posthog"
                      ? "Personal API key with query read access"
                      : "OAuth access token with analytics read access",
                "password",
              )}
            </div>
            <button>Save connection</button>
          </form>
        </details>
        <h3>Acceptance checks</h3>
        <p className="small muted">
          Checks are tied to confirmed requirements. A failed or unverified
          check prevents a supported finding. A passing check verifies only its
          stated behavior.
        </p>
        {plan.checks.map((c) => (
          <div className="connection-row" key={c.id}>
            <span>
              {c.requirementId} · {kinds[c.kind]}
              <small>{c.url || c.expected}</small>
            </span>
            <button
              type="button"
              onClick={() =>
                change({ checks: plan.checks.filter((v) => v.id !== c.id) })
              }
            >
              Remove {c.id}
            </button>
          </div>
        ))}
        <div className="evidence-grid">
          <label>
            Requirement
            <select
              value={requirementId}
              onChange={(e) => setRequirement(e.target.value)}
            >
              {data.scopes.at(-1)?.requirements?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id} · {r.text}
                </option>
              ))}
            </select>
          </label>
          <label>
            Check
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as keyof typeof kinds)}
            >
              {Object.entries(kinds).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {!["ci", "analytics"].includes(kind) && (
            <label>
              Check URL
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
          )}
          {["http", "text", "no_js", "canonical", "analytics"].includes(
            kind,
          ) && (
            <label>
              {kind === "analytics"
                ? "Event name"
                : kind === "http"
                  ? "Expected HTTP status · default 200"
                  : kind === "canonical"
                    ? "Expected canonical · defaults to check URL"
                    : "Expected text"}
              <input
                value={expected}
                onChange={(e) => setExpected(e.target.value)}
              />
            </label>
          )}
        </div>
        <button
          type="button"
          disabled={plan.checks.length >= 24}
          onClick={() => {
            const id = Array.from(
              { length: 99 },
              (_, i) => `check_${i + 1}`,
            ).find((id) => !plan.checks.some((c) => c.id === id))!;
            const check: z.infer<typeof AcceptanceCheckSchema> = {
              id,
              requirementId,
              kind,
              expected,
              ...(!["ci", "analytics"].includes(kind) && url ? { url } : {}),
            };
            change({ checks: [...plan.checks, check] });
          }}
        >
          Add check
        </button>
        <div className="controls">
          <button
            type="button"
            disabled={!dirty}
            onClick={() =>
              void act(async () => {
                const result = EvidencePlanSchema.safeParse({
                  ...plan,
                  targetUrls: plan.targetUrls
                    .map((v) => v.trim())
                    .filter(Boolean),
                });
                if (!result.success)
                  throw new Error(
                    result.error.issues.map((i) => i.message).join(" · "),
                  );
                const updated = await request(
                  `/api/cases/${data.id}/evidence-plan`,
                  result.data,
                );
                onSaved(updated);
                setPlan(result.data);
                setDirty(false);
                setMessage(
                  "Evidence plan saved. The next assessment will use these sources and checks.",
                );
              })
            }
          >
            Save evidence plan
          </button>
          {dirty && (
            <span className="small">Save changes before assessing.</span>
          )}
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </details>
  );
}
