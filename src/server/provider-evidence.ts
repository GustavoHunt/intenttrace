import {
  artifact,
  event,
  type CaseData,
  type Revision,
} from "../shared/domain";
import {
  defaultEvidencePlan,
  type EvidenceConnection,
} from "../shared/investigation";
import { publicPage } from "./public-network";

// Fixed read endpoints and fixed query templates only. Tokens never appear in URLs.
export async function boundedJson(url: string, init: RequestInit) {
  const r = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok)
    throw new Error(
      r.status === 401 || r.status === 403
        ? "Access denied or expired. Reconnect with an authorized read-only credential."
        : r.status === 429
          ? "Provider rate limit reached. Retry later."
          : `Provider returned HTTP ${r.status}.`,
    );
  const reader = r.body?.getReader();
  if (!reader) throw new Error("Provider returned an empty response.");
  let text = "",
    count = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > 1048576)
        throw new Error("Provider response exceeds the 1 MiB evidence limit.");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(text + decoder.decode());
}
export function validateConnection(c: EvidenceConnection) {
  if (c.provider === "cloudflare_access") {
    const url = publicPage(c.origin);
    if (url.origin !== c.origin)
      throw new Error(
        "Enter only the exact HTTPS origin for Cloudflare Access.",
      );
  }
  if (c.provider === "posthog") publicPage(c.site);
  if (
    c.provider === "search_console" &&
    !/^sc-domain:[a-z0-9.-]+$/i.test(c.site)
  )
    publicPage(c.site);
  if (
    /[\r\n]/.test(c.secret) ||
    (c.provider === "cloudflare_access" && /[\r\n]/.test(c.clientId))
  )
    throw new Error("Credentials cannot contain line breaks.");
}
export function credentialHeaders(
  url: string,
  connections: EvidenceConnection[],
  original: Record<string, string> = {},
) {
  const headers = Object.fromEntries(
    Object.entries(original).filter(
      ([k]) =>
        !/^(authorization|cf-access-client-id|cf-access-client-secret)$/i.test(
          k,
        ),
    ),
  );
  const c = connections.find(
    (c) =>
      c.provider === "cloudflare_access" && c.origin === new URL(url).origin,
  );
  if (c?.provider === "cloudflare_access") {
    headers["CF-Access-Client-Id"] = c.clientId;
    headers["CF-Access-Client-Secret"] = c.secret;
  }
  return headers;
}
export function redactCredentials(
  text: string,
  connections: EvidenceConnection[],
) {
  for (const c of connections)
    for (const secret of [
      c.secret,
      ...(c.provider === "cloudflare_access" ? [c.clientId] : []),
    ])
      text = text.split(secret).join("[credential redacted]");
  return text;
}
export async function collectProviderEvidence(
  c: CaseData,
  connections: EvidenceConnection[],
): Promise<NonNullable<Revision["research"]>["sources"]> {
  const sources: NonNullable<Revision["research"]>["sources"] = [];
  const plan = c.evidencePlan || defaultEvidencePlan();
  for (const connection of connections.filter(
    (c) => c.provider !== "cloudflare_access",
  )) {
    const capturedAt = new Date().toISOString();
    let url = "";
    try {
      const headers = {
        Authorization: `Bearer ${connection.secret}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "IntentTrace-evidence",
      };
      let record: Record<string, unknown>;
      if (connection.provider === "github") {
        url = `https://api.github.com/repos/${connection.repository}/actions/runs/${connection.runId}`;
        const run = await boundedJson(url, { headers });
        if (
          run.repository?.full_name?.toLowerCase() !==
            connection.repository.toLowerCase() ||
          String(run.id) !== connection.runId
        )
          throw new Error("Provider returned a different repository or run.");
        const jobs = await boundedJson(`${url}/jobs?per_page=100`, { headers });
        record = {
          provider: "github",
          repository: connection.repository,
          runId: run.id,
          runUrl: run.html_url,
          headSha: run.head_sha,
          status: run.status,
          conclusion: run.conclusion,
          updatedAt: run.updated_at,
          runStartedAt: run.run_started_at,
          jobs: (jobs.jobs || [])
            .slice(0, 100)
            .map((j: any) => ({
              name: j.name,
              status: j.status,
              conclusion: j.conclusion,
              completedAt: j.completed_at,
            })),
          truncated: jobs.total_count > 100,
          boundary:
            "A completed workflow for this commit is CI evidence, not independent deployed-environment or human acceptance proof.",
        };
      } else {
        if (!plan.startDate || !plan.endDate)
          throw new Error(
            "Choose an explicit report start and end date before collecting analytics.",
          );
        const dates = { startDate: plan.startDate, endDate: plan.endDate };
        if (connection.provider === "posthog") {
          url = `https://${connection.region}.posthog.com/api/projects/${connection.projectId}/query/`;
          const host = new URL(connection.site).hostname;
          if (!/^[a-z0-9.-]+$/i.test(host))
            throw new Error("Unsupported analytics hostname.");
          const query = `SELECT event, count() AS count FROM events WHERE timestamp >= toDateTime('${plan.startDate} 00:00:00', 'UTC') AND timestamp < toDateTime('${plan.endDate} 00:00:00', 'UTC') + INTERVAL 1 DAY AND properties.$host = '${host}' GROUP BY event ORDER BY count DESC LIMIT 200`;
          const result = await boundedJson(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
          });
          if (!Array.isArray(result.results))
            throw new Error(
              "The provider did not return a completed aggregate report.",
            );
          record = {
            provider: "posthog",
            projectId: connection.projectId,
            site: connection.site,
            ...dates,
            timezone: "UTC",
            rows: result.results
              .slice(0, 200)
              .map((r: any[]) => ({
                event: String(r[0]).slice(0, 200),
                count: Number(r[1]),
              })),
            truncated: result.results.length >= 200,
            boundary:
              "Aggregated event counts for this hostname. Counts do not prove unique users, attribution, funnel completion or instrumentation correctness.",
          };
        } else if (connection.provider === "search_console") {
          url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(connection.site)}/searchAnalytics/query`;
          const result = await boundedJson(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              ...dates,
              dimensions: ["date", "page"],
              rowLimit: 500,
              dataState: "final",
              type: "web",
            }),
          });
          record = {
            provider: "search_console",
            site: connection.site,
            ...dates,
            timezone: "America/Los_Angeles",
            rows: (result.rows || [])
              .slice(0, 500)
              .map((r: any) => ({
                date: r.keys?.[0],
                page: r.keys?.[1],
                clicks: r.clicks,
                impressions: r.impressions,
                ctr: r.ctr,
                position: r.position,
              })),
            truncated: (result.rows || []).length >= 500,
            boundary:
              "Final web search rows, at most 500. Search Console may omit data; an empty report is not proof of zero traffic or no indexed pages. Brand filtering and index coverage are not established.",
          };
        } else if (connection.provider === "ga4") {
          url = `https://analyticsdata.googleapis.com/v1beta/properties/${connection.propertyId}:runReport`;
          const result = await boundedJson(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              dateRanges: [dates],
              dimensions: [{ name: "eventName" }],
              metrics: [{ name: "eventCount" }],
              limit: "200",
            }),
          });
          record = {
            provider: "ga4",
            propertyId: connection.propertyId,
            ...dates,
            timezone: result.metadata?.timeZone || "Provider property timezone",
            rows: (result.rows || [])
              .slice(0, 200)
              .map((r: any) => ({
                event: r.dimensionValues?.[0]?.value,
                count: Number(r.metricValues?.[0]?.value),
              })),
            truncated: result.rowCount > 200,
            dataLossFromOtherRow: result.metadata?.dataLossFromOtherRow,
            subjectToThresholding: result.metadata?.subjectToThresholding,
            boundary:
              "Aggregated counts for this GA4 property; property-to-site ownership, consent coverage, attribution and tracking correctness require separate verification.",
          };
        } else continue;
      }
      const a = await artifact(
        `Connected evidence: ${connection.label}`,
        "document",
        JSON.parse(
          redactCredentials(
            JSON.stringify({ ...record, capturedAt, sourceUrl: url }),
            connections,
          ),
        ),
      );
      a.observation = "http_response";
      a.sourceUrl = url;
      a.capturedAt = capturedAt;
      a.mediaType = "application/json";
      c.artifacts.push(a);
      event(
        c,
        "evidence",
        a.name,
        `Authenticated read from ${connection.provider}. Credentials excluded; source-specific limits are retained in the artifact.`,
        { artifactIds: [a.id] },
      );
      sources.push({
        url,
        status: "captured",
        detail: `Authenticated ${connection.provider} report; scoped aggregate data.`,
        capturedAt,
        artifactId: a.id,
      });
    } catch (e) {
      const message =
        e instanceof Error &&
        /^(Access denied|Provider|Choose an explicit|Unsupported analytics|The provider)/.test(
          e.message,
        )
          ? e.message
          : "The provider could not be read. Check the selected resource, credential permissions and availability.";
      sources.push({
        url:
          url ||
          `https://${connection.provider === "github" ? "api.github.com" : "www.googleapis.com"}/`,
        status: "failed",
        detail: redactCredentials(
          `${connection.label}: ${message}`,
          connections,
        ),
        capturedAt,
      });
    }
  }
  return sources;
}
