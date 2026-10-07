import { describe, expect, it, vi, afterEach } from "vitest";
import {
  advance,
  CloudflareAPI,
  digest,
  makeReceipt,
  random,
  SCOPES,
  SetupError,
  validateRelease,
  type Release,
} from "../installer/core";
import { pkce, seal, unseal } from "../installer/crypto";
const account = "a".repeat(32);
async function release() {
  const payload = {
    version: "test",
    main: "worker.js",
    modules: [
      {
        name: "worker.js",
        type: "application/javascript+module",
        content: btoa("export default {}"),
      },
    ],
    assets: [
      {
        path: "/index.html",
        type: "text/html",
        content: btoa("test"),
        hash: "a".repeat(32),
      },
    ],
  };
  return {
    ...payload,
    sha256: await digest(JSON.stringify(payload)),
  } as Release;
}
afterEach(() => vi.unstubAllGlobals());
describe("installer credential boundaries", () => {
  it("requests the documented asset deployment scope, not Workers Editor", () => {
    expect(SCOPES).toContain("workers-scripts.write");
    expect(SCOPES).not.toContain("workers-scripts.edit");
  });
  it("requires every live service check and the pinned release", async () => {
    const r = await release(),
      receipt = makeReceipt(account, r);
    receipt.phase = 9;
    receipt.url = "https://example.workers.dev";
    for (const result of [
      { release: r.sha256, checks: {} },
      {
        release: "wrong",
        checks: {
          storage: "passed",
          memory: "passed",
          workflow: "passed",
          workersAI: "passed",
          aiGateway: "passed",
          browser: "passed",
        },
      },
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(result)));
      await expect(
        advance(
          {} as CloudflareAPI,
          receipt,
          { signingSecret: random() },
          r,
          async () => {},
        ),
      ).rejects.toThrow("live checks");
      expect(receipt.phase).toBe(9);
    }
  });
  it("calls native fetch without a class-instance receiver", async () => {
    const transport = function (this: unknown) {
      expect(this).toBeUndefined();
      return Promise.resolve(Response.json({ success: true, result: [] }));
    } as typeof fetch;
    await expect(
      new CloudflareAPI("test", transport).call("/accounts"),
    ).resolves.toEqual([]);
  });
  it("uses Workers-compatible redirect handling without forwarding credentials", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { Location: "https://untrusted.example" },
        }),
      );
    await expect(
      new CloudflareAPI("private-token", transport).call(
        `/accounts/${account}/r2/buckets`,
      ),
    ).rejects.toThrow("No credentials were forwarded");
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][1].redirect).toBe("manual");
  });
  it("authenticates encrypted credentials to the owning session", async () => {
    const secret = random(),
      token = random(),
      encoded = await seal({ token }, secret, "session-a");
    expect(encoded).not.toContain(token);
    expect(await unseal(encoded, secret, "session-a")).toEqual({ token });
    await expect(unseal(encoded, secret, "session-b")).rejects.toThrow();
    await expect(unseal(encoded, random(), "session-a")).rejects.toThrow();
  });
  it("uses fresh PKCE verifiers and SHA-256 challenges", async () => {
    const a = await pkce(),
      b = await pkce();
    expect(a.verifier).toHaveLength(43);
    expect(a.challenge).toHaveLength(43);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(a.verifier);
  });
  it("does not reflect provider response bodies or tokens in errors", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          {
            success: false,
            errors: [{ code: 10000, message: "sensitive-provider-response" }],
          },
          { status: 403 },
        ),
      );
    await expect(
      new CloudflareAPI("secret-value", transport).call(
        `/accounts/${account}/r2/buckets`,
      ),
    ).rejects.toThrow("Cloudflare denied");
    try {
      await new CloudflareAPI("secret-value", transport).call(
        `/accounts/${account}/r2/buckets`,
      );
    } catch (e) {
      expect(String(e)).not.toMatch(/sensitive-provider-response|secret-value/);
    }
  });
  it("turns R2 activation into an actionable, non-mutating error", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { success: false, errors: [{ code: 10042 }] },
          { status: 403 },
        ),
      );
    const api = new CloudflareAPI("test", transport),
      r = await release(),
      receipt = makeReceipt(account, r);
    await expect(
      advance(api, receipt, { signingSecret: random() }, r, async () => {}),
    ).rejects.toMatchObject({
      status: 409,
      helpUrl: expect.stringContaining("r2"),
    });
    expect(receipt.phase).toBe(0);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("pins the release and rejects tampered modules", async () => {
    const r = await release();
    await expect(validateRelease(r)).resolves.toBe(r);
    r.modules[0].content = btoa("changed");
    await expect(validateRelease(r)).rejects.toThrow("integrity");
  });
  it("rejects malformed account IDs and fixes generated resource names", async () => {
    const r = await release();
    expect(() => makeReceipt("../other", r)).toThrow();
    const receipt = makeReceipt(account, r);
    expect(receipt.name).toMatch(/^intenttrace-[a-f0-9]{12}$/);
    expect(receipt.bucket).toBe(receipt.name + "-evidence");
  });
  it("never overwrites an existing Worker on preflight", async () => {
    const r = await release(),
      receipt = makeReceipt(account, r);
    const call = vi.fn(async (path: string) =>
      path.endsWith("/subdomain")
        ? { subdomain: "test" }
        : path.endsWith("/scripts")
          ? [{ id: receipt.name }]
          : [],
    );
    await expect(
      advance(
        { call } as unknown as CloudflareAPI,
        receipt,
        { signingSecret: random() },
        r,
        async () => {},
      ),
    ).rejects.toThrow("already exists");
    expect(receipt.phase).toBe(0);
    expect(call.mock.calls.every((c) => c.length === 1)).toBe(true);
  });
  it("reuses a widget after an interrupted response without creating another", async () => {
    const r = await release(),
      receipt = makeReceipt(account, r);
    receipt.phase = 4;
    receipt.url = "https://example.workers.dev";
    const call = vi.fn(async (path: string) =>
      path.includes("per_page")
        ? [{ name: receipt.name, sitekey: "public-key" }]
        : { sitekey: "public-key", secret: "widget-secret" },
    );
    const secrets = { signingSecret: random() };
    const save = vi.fn(async () => {});
    await advance(
      { call } as unknown as CloudflareAPI,
      receipt,
      secrets,
      r,
      save,
    );
    expect(receipt.phase).toBe(5);
    expect(secrets).toHaveProperty("turnstileSecret", "widget-secret");
    expect(save).toHaveBeenCalledOnce();
    expect(JSON.stringify(receipt)).not.toContain("widget-secret");
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("preserves the step on provider failure and resumes the same resource", async () => {
    const r = await release(),
      receipt = makeReceipt(account, r);
    receipt.phase = 2;
    const call = vi
      .fn()
      .mockRejectedValueOnce(new SetupError("temporary", 502))
      .mockResolvedValueOnce({});
    const api = { call } as unknown as CloudflareAPI,
      secrets = { signingSecret: random() },
      save = vi.fn(async () => {});
    await expect(advance(api, receipt, secrets, r, save)).rejects.toThrow(
      "temporary",
    );
    expect(receipt.phase).toBe(2);
    await advance(api, receipt, secrets, r, save);
    expect(receipt.phase).toBe(3);
    expect(call.mock.calls[0]).toEqual(call.mock.calls[1]);
  });
  it("refuses to mark pending or wrong-release health checks complete", async () => {
    const r = await release(),
      receipt = makeReceipt(account, r);
    receipt.phase = 9;
    receipt.url = "https://example.workers.dev";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { release: r.sha256, checks: { workflow: "pending" } },
            { status: 202 },
          ),
        ),
    );
    await advance(
      {} as CloudflareAPI,
      receipt,
      { signingSecret: random() },
      r,
      async () => {},
    );
    expect(receipt.phase).toBe(9);
    expect(receipt.checks).toBeUndefined();
  });
});
