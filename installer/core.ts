/** Shared by the hosted OAuth installer and the local account-validation CLI. */
export const SCOPES = [
  "account-settings.read",
  "workers-scripts.write",
  "workers-r2.write",
  "ai.write",
  "aig.read",
  "aig.write",
  "challenge-widgets.write",
];
export const PHASES = [
  "Check account",
  "Create evidence storage",
  "Set retention",
  "Create AI Gateway",
  "Create Turnstile",
  "Upload interface",
  "Deploy application",
  "Register workflow",
  "Enable address",
  "Verify deployment",
] as const;
export type Release = {
  version: string;
  sha256: string;
  main: string;
  modules: { name: string; type: string; content: string }[];
  assets: { path: string; hash: string; content: string; type: string }[];
};
export type Receipt = {
  id: string;
  accountId: string;
  name: string;
  bucket: string;
  gateway: string;
  workflow: string;
  phase: number;
  version: string;
  releaseHash: string;
  previousReleaseHashes?: string[];
  subdomain?: string;
  sitekey?: string;
  url?: string;
  checks?: Record<string, string>;
  created: string[];
  error?: string;
  helpUrl?: string;
};
export type PrivateState = {
  signingSecret: string;
  turnstileSecret?: string;
  uploadJwt?: string;
  assetJwt?: string;
};
export class SetupError extends Error {
  constructor(
    message: string,
    public status = 400,
    public helpUrl?: string,
  ) {
    super(message);
  }
}
export class CloudflareAPI {
  constructor(
    private token: string,
    private transport: typeof fetch = fetch,
  ) {}
  async call<T = any>(
    path: string,
    method = "GET",
    body?: unknown,
    token = this.token,
  ): Promise<T> {
    if (!path.startsWith("/") || path.includes("..") || path.startsWith("//"))
      throw new SetupError("Invalid Cloudflare operation");
    const form = body instanceof FormData;
    // Workers' native fetch rejects a class instance as its receiver.
    const transport = this.transport;
    const response = await transport(
      `https://api.cloudflare.com/client/v4${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(!form && body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        body:
          body === undefined ? undefined : form ? body : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(25000),
      },
    );
    if (response.status >= 300 && response.status < 400)
      throw new SetupError(
        "Unexpected redirect from Cloudflare. No credentials were forwarded.",
        502,
      );
    let json: { success?: boolean; result?: T; errors?: { code: number }[] };
    try {
      json = await response.json();
    } catch {
      throw new SetupError(
        `Cloudflare returned a non-JSON API response (HTTP ${response.status}). Retry this step.`,
        502,
      );
    }
    if (!response.ok || json.success === false) {
      const code = json.errors?.[0]?.code;
      if (code === 10042)
        throw new SetupError(
          "Enable R2 in Cloudflare, then retry this step.",
          409,
          "https://dash.cloudflare.com/?to=/:account/r2/overview",
        );
      if (response.status === 401 || response.status === 403)
        throw new SetupError(
          `Cloudflare denied ${path.split("/").slice(3, 5).join("/") || "account access"}. Reconnect with the required permissions.`,
          403,
        );
      throw new SetupError(
        `Cloudflare operation failed (HTTP ${response.status}${code ? `, code ${code}` : ""}). Retry this step.`,
        502,
      );
    }
    return json.result as T;
  }
}
export const bytes = (text: string) =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
export const base64 = (data: Uint8Array) => {
  let s = "";
  for (const b of data) s += String.fromCharCode(b);
  return btoa(s);
};
export const random = () =>
  base64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
export async function digest(text: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export async function validateRelease(release: Release) {
  const { sha256, ...payload } = release;
  if ((await digest(JSON.stringify(payload))) !== sha256)
    throw new SetupError("Release integrity check failed", 503);
  if (
    !release.modules.some((m) => m.name === release.main) ||
    !release.assets.some((a) => a.path === "/index.html")
  )
    throw new SetupError("Release is missing application files", 503);
  return release;
}
export function makeReceipt(
  accountId: string,
  release: Release,
  id = crypto.randomUUID(),
): Receipt {
  if (!/^[a-f0-9]{32}$/.test(accountId) || !/^[a-f0-9-]{36}$/.test(id))
    throw new SetupError("Invalid installation identity");
  const name = `intenttrace-${id.replaceAll("-", "").slice(0, 12)}`;
  return {
    id,
    accountId,
    name,
    bucket: `${name}-evidence`,
    gateway: name,
    workflow: `${name}-investigate`,
    phase: 0,
    version: release.version,
    releaseHash: release.sha256,
    created: [],
  };
}
/** One resumable step. Only installation-specific names are ever mutated. */
export async function advance(
  api: CloudflareAPI,
  receipt: Receipt,
  secrets: PrivateState,
  release: Release,
  save: () => Promise<void>,
) {
  if (receipt.releaseHash !== release.sha256)
    throw new SetupError(
      "Installer release changed. Finish using the original release or start a new installation.",
      409,
    );
  const root = `/accounts/${receipt.accountId}`,
    script = `${root}/workers/scripts/${receipt.name}`;
  const remember = (resource: string) => {
    if (!receipt.created.includes(resource)) receipt.created.push(resource);
  };
  switch (receipt.phase) {
    case 0: {
      await api.call(`${root}/r2/buckets?per_page=1`);
      await api.call(`${root}/ai-gateway/gateways?per_page=1`);
      await api.call(`${root}/challenges/widgets?per_page=1`);
      const sub = await api.call<{ subdomain: string }>(
        `${root}/workers/subdomain`,
      );
      if (!sub?.subdomain || !/^[a-z0-9-]+$/.test(sub.subdomain))
        throw new SetupError(
          "Set up your workers.dev address in Cloudflare, then retry.",
          409,
          "https://dash.cloudflare.com/?to=/:account/workers-and-pages",
        );
      receipt.subdomain = sub.subdomain;
      receipt.url = `https://${receipt.name}.${sub.subdomain}.workers.dev`;
      const existing = await api.call<{ id: string }[]>(
        `${root}/workers/scripts`,
      );
      if (existing.some((s) => s.id === receipt.name))
        throw new SetupError(
          "This Worker name already exists. Start a new installation to avoid overwriting it.",
          409,
        );
      break;
    }
    case 1: {
      const found = await api.call<{ buckets: { name: string }[] }>(
        `${root}/r2/buckets?name=${receipt.bucket}`,
      );
      if (!found.buckets?.some((b) => b.name === receipt.bucket))
        await api.call(`${root}/r2/buckets`, "POST", { name: receipt.bucket });
      remember(receipt.bucket);
      break;
    }
    case 2:
      await api.call(`${root}/r2/buckets/${receipt.bucket}/lifecycle`, "PUT", {
        rules: [
          {
            id: "expire-evidence",
            enabled: true,
            conditions: { prefix: "" },
            deleteObjectsTransition: {
              condition: { type: "Age", maxAge: 86400 },
            },
          },
        ],
      });
      break;
    case 3: {
      const gateways = await api.call<{ id: string }[]>(
        `${root}/ai-gateway/gateways?per_page=100`,
      );
      if (!gateways.some((g) => g.id === receipt.gateway))
        await api.call(`${root}/ai-gateway/gateways`, "POST", {
          id: receipt.gateway,
          collect_logs: false,
          cache_invalidate_on_update: true,
          cache_ttl: 0,
          rate_limiting_interval: 60,
          rate_limiting_limit: 20,
          rate_limiting_technique: "sliding",
          authentication: true,
        });
      remember(receipt.gateway);
      break;
    }
    case 4: {
      // Persist both keys together. A lost response is recovered by widget name.
      const widgets = await api.call<{ name: string; sitekey: string }[]>(
        `${root}/challenges/widgets?per_page=100`,
      );
      const existing = widgets.find((w) => w.name === receipt.name);
      const widget = existing
        ? await api.call<{ sitekey: string; secret: string }>(
            `${root}/challenges/widgets/${existing.sitekey}`,
          )
        : await api.call<{ sitekey: string; secret: string }>(
            `${root}/challenges/widgets`,
            "POST",
            {
              name: receipt.name,
              domains: [new URL(receipt.url!).hostname],
              mode: "managed",
              bot_fight_mode: false,
            },
          );
      if (!widget.secret || !widget.sitekey)
        throw new SetupError(
          "Turnstile did not return the required credentials",
          502,
        );
      receipt.sitekey = widget.sitekey;
      secrets.turnstileSecret = widget.secret;
      remember(`turnstile:${widget.sitekey}`);
      break;
    }
    case 5: {
      const manifest = Object.fromEntries(
        release.assets.map((a) => [
          a.path,
          { hash: a.hash, size: bytes(a.content).length },
        ]),
      );
      const session = await api.call<{ jwt: string; buckets: string[][] }>(
        `${script}/assets-upload-session`,
        "POST",
        { manifest },
      );
      let jwt = session.jwt;
      for (const bucket of session.buckets) {
        const form = new FormData();
        for (const hash of bucket) {
          const asset = release.assets.find((a) => a.hash === hash);
          if (!asset)
            throw new SetupError("Cloudflare requested an unknown asset", 502);
          form.set(hash, new File([asset.content], hash, { type: asset.type }));
        }
        const upload = await api.call<{ jwt?: string }>(
          `${root}/workers/assets/upload?base64=true`,
          "POST",
          form,
          session.jwt,
        );
        if (upload.jwt) jwt = upload.jwt;
      }
      secrets.assetJwt = jwt;
      break;
    }
    case 6: {
      if (!secrets.turnstileSecret || !secrets.assetJwt)
        throw new SetupError(
          "Installation credentials are incomplete. Reconnect and retry.",
          409,
        );
      const bindings: Record<string, unknown>[] = [
        { type: "r2_bucket", name: "EVIDENCE", bucket_name: receipt.bucket },
        { type: "ai", name: "AI" },
        { type: "browser", name: "BROWSER" },
        { type: "assets", name: "ASSETS" },
        ...["CaseAgent", "SessionRegistry", "BudgetGuard"].map(
          (class_name, i) => ({
            type: "durable_object_namespace",
            name: ["CaseAgent", "SESSIONS", "BUDGET"][i],
            class_name,
          }),
        ),
        {
          type: "workflow",
          name: "INVESTIGATE",
          workflow_name: receipt.workflow,
          class_name: "InvestigationWorkflow",
        },
        ...Object.entries({
          MODEL_ID: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          AI_GATEWAY_ID: receipt.gateway,
          TURNSTILE_SITE_KEY: receipt.sitekey!,
          SESSION_MODEL_LIMIT: "30",
          DAILY_MODEL_LIMIT: "200",
          INSTALL_RELEASE: release.sha256,
        }).map(([name, text]) => ({ type: "plain_text", name, text })),
        ...Object.entries({
          TURNSTILE_SECRET_KEY: secrets.turnstileSecret,
          SESSION_SIGNING_SECRET: secrets.signingSecret,
        }).map(([name, text]) => ({ type: "secret_text", name, text })),
      ];
      const metadata = {
        main_module: release.main,
        compatibility_date: "2026-10-06",
        compatibility_flags: ["nodejs_compat"],
        bindings,
        ...(!receipt.created.includes(receipt.name)
          ? {
              migrations: {
                new_tag: "v1",
                steps: [
                  {
                    new_sqlite_classes: [
                      "CaseAgent",
                      "SessionRegistry",
                      "BudgetGuard",
                    ],
                  },
                ],
              },
            }
          : {}),
        assets: {
          jwt: secrets.assetJwt,
          config: {
            not_found_handling: "single-page-application",
            run_worker_first: ["/api/*", "/agents/*"],
          },
        },
        observability: { enabled: true },
      };
      const form = new FormData();
      form.set("metadata", JSON.stringify(metadata));
      for (const m of release.modules)
        form.set(
          m.name,
          new File([bytes(m.content)], m.name, { type: m.type }),
        );
      await api.call(script, "PUT", form);
      remember(receipt.name);
      break;
    }
    case 7:
      await api.call(`${root}/workflows/${receipt.workflow}`, "PUT", {
        script_name: receipt.name,
        class_name: "InvestigationWorkflow",
      });
      remember(receipt.workflow);
      break;
    case 8:
      await api.call(`${script}/subdomain`, "POST", {
        enabled: true,
        previews_enabled: false,
      });
      break;
    case 9: {
      const response = await fetch(`${receipt.url}/api/install-check`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secrets.signingSecret}` },
        redirect: "manual",
        signal: AbortSignal.timeout(60000),
      });
      if (response.status >= 300 && response.status < 400)
        throw new SetupError(
          "Unexpected verification redirect. No credentials were forwarded.",
          502,
        );
      const result = (await response.json()) as {
        checks?: Record<string, string>;
        release?: string;
      };
      if (
        response.status === 202 &&
        result.release === release.sha256 &&
        result.checks?.workflow === "pending"
      ) {
        delete receipt.error;
        await save();
        return;
      }
      const requiredChecks = [
        "storage",
        "memory",
        "workflow",
        "workersAI",
        "aiGateway",
        "browser",
      ];
      if (
        !response.ok ||
        result.release !== release.sha256 ||
        !result.checks ||
        requiredChecks.some((key) => result.checks![key] !== "passed")
      )
        throw new SetupError(
          "The app deployed, but its live checks have not all passed. Retry verification; your resources are preserved.",
          502,
        );
      receipt.checks = result.checks;
      break;
    }
    default:
      return;
  }
  receipt.phase++;
  delete receipt.error;
  delete receipt.helpUrl;
  await save();
}
