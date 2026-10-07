import { DurableObject } from "cloudflare:workers";
import {
  advance,
  CloudflareAPI,
  makeReceipt,
  PHASES,
  random,
  SCOPES,
  SetupError,
  validateRelease,
  type PrivateState,
  type Receipt,
  type Release,
} from "./core";
import { pkce, seal, unseal } from "./crypto";

interface Env {
  ASSETS: Fetcher;
  INSTALLS: DurableObjectNamespace<Installation>;
  INSTALLER_ORIGIN: string;
  OAUTH_CLIENT_ID: string;
  OAUTH_CLIENT_SECRET?: string;
  ENCRYPTION_SECRET: string;
  INSTALL_RATE: RateLimit;
}
type Credentials = {
  token?: string;
  verifier?: string;
  oauthState?: string;
  secrets?: PrivateState;
};
type RecordState = {
  id: string;
  expiresAt: number;
  vault: string;
  receipt?: Receipt;
  accounts?: { id: string; name: string }[];
  revoked?: boolean;
};
const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers });
const redirect = (url: string, cookie?: string) =>
  new Response(null, {
    status: 303,
    headers: {
      ...headers,
      Location: url,
      ...(cookie ? { "Set-Cookie": cookie } : {}),
    },
  });
const cookie = (id: string, secure: boolean) =>
  `intenttrace_install=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1800${secure ? "; Secure" : ""}`;
async function limitedJson(req: Request) {
  const reader = req.body?.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        throw new SetupError("Request is too large", 413);
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new SetupError("Invalid request");
  }
}
async function revoke(token: string, env: Env) {
  const body = new URLSearchParams({ token, client_id: env.OAUTH_CLIENT_ID });
  if (env.OAUTH_CLIENT_SECRET)
    body.set("client_secret", env.OAUTH_CLIENT_SECRET);
  const r = await fetch("https://dash.cloudflare.com/oauth2/revoke", {
    method: "POST",
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  return r.ok;
}
export class Installation extends DurableObject<Env> {
  private busy = false;
  private stage = "loading session";
  async fetch(req: Request) {
    if (this.busy)
      return json(
        { error: "Another installation step is running. Please wait." },
        409,
      );
    this.busy = true;
    try {
      return await this.handle(req);
    } catch (e) {
      return json(
        {
          error:
            e instanceof SetupError
              ? e.message
              : `Installation could not continue while ${this.stage}. Retry the step.`,
          helpUrl: e instanceof SetupError ? e.helpUrl : undefined,
        },
        e instanceof SetupError ? e.status : 502,
      );
    } finally {
      this.busy = false;
    }
  }
  private async handle(req: Request) {
    const action = new URL(req.url).pathname;
    this.stage = "loading session";
    let state = await this.ctx.storage.get<RecordState>("state");
    if (action === "/start") {
      const pair = await pkce(),
        id = new URL(req.url).searchParams.get("id")!;
      const prior =
        state && state.expiresAt > Date.now()
          ? await unseal<Credentials>(
              state.vault,
              this.env.ENCRYPTION_SECRET,
              id,
            )
          : undefined;
      if (prior?.token && !(await revoke(prior.token, this.env)))
        throw new SetupError(
          "Could not revoke the previous connection. Retry connecting.",
          502,
        );
      const creds: Credentials = {
        verifier: pair.verifier,
        oauthState: random(),
        secrets: prior?.secrets,
      };
      state = {
        id,
        expiresAt: Date.now() + 30 * 60_000,
        vault: await seal(creds, this.env.ENCRYPTION_SECRET, id),
        receipt: prior ? state?.receipt : undefined,
      };
      await this.ctx.storage.put("state", state);
      await this.ctx.storage.setAlarm(state.expiresAt);
      const auth = new URL("https://dash.cloudflare.com/oauth2/auth");
      auth.search = new URLSearchParams({
        client_id: this.env.OAUTH_CLIENT_ID,
        redirect_uri: this.env.INSTALLER_ORIGIN + "/oauth/callback",
        response_type: "code",
        scope: SCOPES.join(" "),
        state: creds.oauthState!,
        code_challenge: pair.challenge,
        code_challenge_method: "S256",
      }).toString();
      return json({ url: auth.href });
    }
    if (!state || state.expiresAt < Date.now())
      throw new SetupError(
        "Your installation session expired. Connect to Cloudflare again.",
        401,
      );
    this.stage = "opening the credential vault";
    let creds = await unseal<Credentials>(
      state.vault,
      this.env.ENCRYPTION_SECRET,
      state.id,
    );
    const save = async () => {
      state!.vault = await seal(creds, this.env.ENCRYPTION_SECRET, state!.id);
      await this.ctx.storage.put("state", state!);
    };
    if (action === "/callback") {
      this.stage = "validating the callback";
      const input = await limitedJson(req);
      if (!creds.oauthState || input.state !== creds.oauthState)
        throw new SetupError(
          "Sign-in session mismatch or expired callback. Connect again in the same browser.",
          403,
        );
      if (typeof input.code !== "string" || input.code.length > 12000)
        throw new SetupError(
          "Cloudflare returned an invalid authorization code.",
          403,
        );
      const verifier = creds.verifier!;
      this.stage = "consuming the callback";
      delete creds.oauthState;
      delete creds.verifier;
      await save(); // consume before token exchange
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        client_id: this.env.OAUTH_CLIENT_ID,
        redirect_uri: this.env.INSTALLER_ORIGIN + "/oauth/callback",
        code_verifier: verifier,
      });
      if (this.env.OAUTH_CLIENT_SECRET)
        body.set("client_secret", this.env.OAUTH_CLIENT_SECRET);
      let response: Response;
      try {
        response = await fetch("https://dash.cloudflare.com/oauth2/token", {
          method: "POST",
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(20000),
        });
      } catch {
        throw new SetupError(
          "Cloudflare token endpoint could not be reached. Connect again.",
          502,
        );
      }
      if (response.status >= 300 && response.status < 400)
        throw new SetupError(
          "Unexpected token endpoint redirect. No credentials were forwarded.",
          502,
        );
      let result: {
        access_token?: string;
        expires_in?: number;
        error?: string;
      };
      try {
        result = await response.json();
      } catch {
        throw new SetupError(
          `Cloudflare token endpoint returned a non-JSON response (HTTP ${response.status}). Connect again.`,
          502,
        );
      }
      if (
        !response.ok ||
        typeof result.access_token !== "string" ||
        !result.access_token
      )
        throw new SetupError(
          `Cloudflare token exchange failed (HTTP ${response.status}; ${["invalid_grant", "invalid_client", "unauthorized_client", "invalid_request"].includes(result.error || "") ? result.error : "provider response"}). Connect again.`,
          401,
        );
      this.stage = "saving the Cloudflare connection";
      creds.token = result.access_token;
      if (state.receipt) {
        delete state.receipt.error;
        delete state.receipt.helpUrl;
      }
      state.expiresAt = Math.min(
        state.expiresAt,
        Date.now() + (result.expires_in || 1800) * 1000,
      );
      await save();
      await this.ctx.storage.setAlarm(state.expiresAt);
      return json({ connected: true });
    }
    if (action === "/status") {
      if (creds.token && !state.accounts) {
        this.stage = "listing authorized accounts";
        const api = new CloudflareAPI(creds.token);
        state.accounts = await api.call<{ id: string; name: string }[]>(
          "/accounts?per_page=50",
        );
        await save();
      }
      return json({
        connected: Boolean(creds.token),
        accounts: state.accounts || [],
        receipt: state.receipt,
        phases: PHASES,
        accessRevoked: state.revoked,
        expiresAt: state.expiresAt,
      });
    }
    if (action === "/disconnect") {
      if (creds.token) state.revoked = await revoke(creds.token, this.env);
      if (!state.revoked && creds.token)
        throw new SetupError(
          "Cloudflare did not confirm revocation. Retry disconnect or revoke IntentTrace in your Cloudflare profile.",
          502,
        );
      creds = {};
      await save();
      return json({ disconnected: true });
    }
    if (!creds.token)
      throw new SetupError("Connect to Cloudflare to continue.", 401);
    if (action === "/install") {
      const input = await limitedJson(req);
      if (state.receipt) return json({ receipt: state.receipt });
      if (!state.accounts?.some((a) => a.id === input.accountId))
        throw new SetupError("Select an account returned by Cloudflare.", 403);
      const response = await this.env.ASSETS.fetch(
        new Request("https://assets.local/release.json"),
      );
      if (!response.ok)
        throw new SetupError("The installer release has not been built.", 503);
      const release = await validateRelease((await response.json()) as Release);
      state.receipt = makeReceipt(input.accountId, release);
      creds.secrets = { signingSecret: random() + random() };
      await save();
      return json({ receipt: state.receipt });
    }
    if (action === "/update" && state.receipt && creds.secrets) {
      if (
        state.receipt.phase !== 9 ||
        !state.accounts?.some((a) => a.id === state.receipt!.accountId)
      )
        throw new SetupError(
          "Only an authorized deployment awaiting verification can be updated.",
          409,
        );
      const response = await this.env.ASSETS.fetch(
        new Request("https://assets.local/release.json"),
      );
      const release = await validateRelease((await response.json()) as Release);
      if (release.sha256 !== state.receipt.releaseHash) {
        state.receipt.previousReleaseHashes = [
          ...(state.receipt.previousReleaseHashes || []),
          state.receipt.releaseHash,
        ];
        state.receipt.releaseHash = release.sha256;
        state.receipt.version = release.version;
        state.receipt.phase = 5;
        delete state.receipt.error;
        delete state.receipt.helpUrl;
        await save();
      }
      return json({ receipt: state.receipt });
    }
    if (action === "/step" && state.receipt && creds.secrets) {
      if (
        !state.accounts?.some(
          (account) => account.id === state.receipt!.accountId,
        )
      )
        throw new SetupError(
          "Reconnect and authorize the account in this installation receipt.",
          403,
        );
      try {
        const response = await this.env.ASSETS.fetch(
          new Request("https://assets.local/release.json"),
        );
        const release = await validateRelease(
          (await response.json()) as Release,
        );
        await advance(
          new CloudflareAPI(creds.token),
          state.receipt,
          creds.secrets,
          release,
          save,
        );
        if (state.receipt.phase === PHASES.length) {
          state.revoked = await revoke(creds.token, this.env);
          if (state.revoked) creds = {};
          await save();
        }
      } catch (e) {
        state.receipt.error =
          e instanceof SetupError
            ? e.message
            : "The connection was interrupted. Retry this step.";
        state.receipt.helpUrl = e instanceof SetupError ? e.helpUrl : undefined;
        await save();
      }
      return json({ receipt: state.receipt, accessRevoked: state.revoked });
    }
    throw new SetupError("Unknown installation operation", 404);
  }
  async alarm() {
    const state = await this.ctx.storage.get<RecordState>("state");
    if (state) {
      try {
        const creds = await unseal<Credentials>(
          state.vault,
          this.env.ENCRYPTION_SECRET,
          state.id,
        );
        if (creds.token) await revoke(creds.token, this.env);
      } catch {
        /* Expiration still destroys our credential copy. */
      }
    }
    await this.ctx.storage.deleteAll();
  }
}
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/config")
      return json({
        configured: Boolean(
          env.OAUTH_CLIENT_ID && env.ENCRYPTION_SECRET && env.INSTALLER_ORIGIN,
        ),
        phases: PHASES,
      });
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/oauth/")
    ) {
      if (
        !env.OAUTH_CLIENT_ID ||
        !env.ENCRYPTION_SECRET ||
        url.origin !== env.INSTALLER_ORIGIN
      )
        return json(
          {
            error:
              "The installer owner must configure Cloudflare OAuth before connecting an account.",
          },
          503,
        );
      if (req.method !== "GET" && req.headers.get("Origin") !== url.origin)
        return json({ error: "Request origin rejected" }, 403);
      if (
        req.method === "POST" &&
        !(
          await env.INSTALL_RATE.limit({
            key: req.headers.get("CF-Connecting-IP") || "local",
          })
        ).success
      )
        return json(
          { error: "Too many setup requests. Wait one minute and retry." },
          429,
        );
      if (url.pathname === "/oauth/start" && req.method === "POST") {
        const priorId = req.headers
          .get("Cookie")
          ?.match(
            /(?:^|;\s*)intenttrace_install=([A-Za-z0-9_-]{43})(?:;|$)/,
          )?.[1];
        const id = priorId || random(),
          stub = env.INSTALLS.get(env.INSTALLS.idFromName(id));
        const result = await stub.fetch(
          new Request(`https://internal/start?id=${id}`, { method: "POST" }),
        );
        if (!result.ok) return result;
        return redirect(
          ((await result.json()) as { url: string }).url,
          cookie(id, url.protocol === "https:"),
        );
      }
      const id = req.headers
        .get("Cookie")
        ?.match(
          /(?:^|;\s*)intenttrace_install=([A-Za-z0-9_-]{43})(?:;|$)/,
        )?.[1];
      if (!id) return json({ error: "Connect to Cloudflare to begin." }, 401);
      const stub = env.INSTALLS.get(env.INSTALLS.idFromName(id));
      if (url.pathname === "/oauth/callback" && req.method === "GET") {
        if (url.searchParams.has("error")) {
          const code = url.searchParams.get("error");
          if (code === "access_denied")
            return redirect("/?connection=cancelled");
          return redirect(
            "/?connection=failed&reason=" +
              encodeURIComponent(
                code === "invalid_scope"
                  ? "The OAuth client does not allow the required deployment scopes. Its owner must configure Workers Scripts Write, then reconnect."
                  : "Cloudflare rejected the authorization request. Check the OAuth client configuration.",
              ),
          );
        }
        const result = await stub.fetch(
          new Request("https://internal/callback", {
            method: "POST",
            body: JSON.stringify({
              code: url.searchParams.get("code"),
              state: url.searchParams.get("state"),
            }),
          }),
        );
        if (result.ok) return redirect("/");
        const failure = (await result.json()) as { error?: string };
        return redirect(
          "/?connection=failed&reason=" +
            encodeURIComponent(failure.error || "Callback failed"),
        );
      }
      const match = url.pathname.match(
        /^\/api\/(status|install|step|update|disconnect)$/,
      );
      if (
        !match ||
        (match[1] === "status" ? req.method !== "GET" : req.method !== "POST")
      )
        return json({ error: "Not found" }, 404);
      // Materialize a bounded body before forwarding. The DO must not retain the
      // outer request stream after the local proxy has sent its response.
      let body: string | undefined;
      if (req.method === "POST") {
        try {
          body = JSON.stringify(await limitedJson(req));
        } catch (error) {
          return json(
            {
              error:
                error instanceof SetupError ? error.message : "Invalid request",
            },
            error instanceof SetupError ? error.status : 400,
          );
        }
      }
      return stub.fetch(
        new Request(`https://internal/${match[1]}`, {
          method: req.method,
          body,
        }),
      );
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
